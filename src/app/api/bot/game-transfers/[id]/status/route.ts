import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameCredits, gameTransfers, players, transactions } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import {
  BotError,
  botErrorResponse,
  gameTransferJson,
  jsonError,
} from "@/lib/bot-crud";

const bodySchema = z.object({
  status: z.enum(["processing", "completed", "failed"]),
  note: z.string().max(500).optional(),
});

/** Statuses a transfer can still be driven out of. */
const OPEN_STATUSES = ["pending", "solving", "processing"] as const;

/**
 * PATCH /api/bot/game-transfers/:id/status
 * The agent drives a CS-requested game credit transfer through its lifecycle:
 *
 *   pending ──claim──▶ processing ──▶ completed
 *      ▲                   │       └─▶ failed
 *      └─ solving ◀─stalled┘
 *
 *   - processing: claim it — you're starting the back-office move now. From
 *     "pending" or "solving" only; claiming twice is a no-op, not an error, so
 *     a retried claim after a timeout is safe.
 *   - completed: credits move from_game → to_game atomically (validated under a
 *     row lock — the balance may have changed since the request).
 *   - failed: no credits move, nothing to reverse. Send a `note` saying why.
 *
 * Claiming is optional: an agent that goes straight from pending to completed
 * still works. It only costs you the "is anyone actually on this" signal.
 * A transfer that already reached a terminal state is a 409.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const transferId = Number(id);
  if (!Number.isInteger(transferId) || transferId <= 0) {
    return jsonError("Invalid transfer id");
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Provide status: completed | failed (optional note)");
  }
  const body = parsed.data;

  try {
    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(gameTransfers)
        .where(eq(gameTransfers.transfer_id, transferId))
        .for("update");
      if (!row) throw new BotError(404, "Game transfer not found");
      if (!(OPEN_STATUSES as readonly string[]).includes(row.status)) {
        throw new BotError(
          409,
          `Transfer already ${row.status} — it can't be changed`,
        );
      }

      const nowIso = new Date().toISOString();

      // Claiming: mark that the agent has started, and restart the stall clock so
      // the 5-minute sweep measures from "work began", not "CS asked".
      if (body.status === "processing") {
        const [owner] = await txn
          .select({ game_accounts: players.game_accounts })
          .from(players)
          .where(eq(players.player_id, row.player_id));

        // Already claimed — a retried claim after a timeout, not an error.
        if (row.status === "processing") {
          return { transfer: row, gameAccounts: owner?.game_accounts ?? null };
        }

        const [claimed] = await txn
          .update(gameTransfers)
          .set({
            status: "processing",
            started_at: nowIso,
            note: body.note ?? row.note,
          })
          .where(eq(gameTransfers.transfer_id, transferId))
          .returning();
        return { transfer: claimed, gameAccounts: owner?.game_accounts ?? null };
      }

      if (body.status === "completed") {
        // Re-validate the source balance atomically — it may have moved since
        // the CS request created this transfer.
        const [fromCredit] = await txn
          .select()
          .from(gameCredits)
          .where(
            and(
              eq(gameCredits.player_id, row.player_id),
              eq(gameCredits.game_name, row.from_game),
            ),
          )
          .for("update");
        const fromBalance = fromCredit?.current_balance ?? 0;
        if (fromBalance < row.transfer_amount) {
          throw new BotError(
            422,
            `Insufficient ${row.from_game} balance (${fromBalance.toFixed(2)} available, ${row.transfer_amount.toFixed(2)} needed)`,
          );
        }

        await txn
          .update(gameCredits)
          .set({
            current_balance: +(fromBalance - row.transfer_amount).toFixed(2),
            last_updated_at: nowIso,
          })
          .where(
            and(
              eq(gameCredits.player_id, row.player_id),
              eq(gameCredits.game_name, row.from_game),
            ),
          );
        await txn
          .insert(gameCredits)
          .values({
            player_id: row.player_id,
            game_name: row.to_game,
            current_balance: row.transfer_amount,
            last_updated_at: nowIso,
          })
          .onConflictDoUpdate({
            target: [gameCredits.player_id, gameCredits.game_name],
            set: {
              current_balance: sql`${gameCredits.current_balance} + ${row.transfer_amount}`,
              last_updated_at: nowIso,
            },
          });
      }

      const [updated] = await txn
        .update(gameTransfers)
        .set({
          status: body.status,
          completed_at: nowIso,
          // Keep the reason on the row itself, not just buried in the audit
          // trail — CS reads it off the transfer list.
          note: body.note ?? null,
          // A transfer that somehow reached here without a start time still
          // gets one, so the UI never shows an end without a start.
          started_at: row.started_at ?? row.created_at,
        })
        .where(eq(gameTransfers.transfer_id, transferId))
        .returning();

      const [player] = await txn
        .select({
          company_entity_id: players.company_entity_id,
          game_accounts: players.game_accounts,
        })
        .from(players)
        .where(eq(players.player_id, row.player_id));

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: player?.company_entity_id ?? null,
        type: "game_transfer",
        amount: row.transfer_amount,
        game_name: `${row.from_game} → ${row.to_game}`,
        reference_id: row.transfer_id,
        details: {
          source: "bot",
          action: body.status,
          api_key_label: auth.label,
          note: body.note ?? null,
        },
      });

      return { transfer: updated, gameAccounts: player?.game_accounts ?? null };
    });

    return Response.json({
      transfer: gameTransferJson(result.transfer, {
        game_accounts: result.gameAccounts,
      }),
    });
  } catch (e) {
    return botErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

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
  status: z.enum(["completed", "failed"]),
  note: z.string().max(500).optional(),
});

/**
 * PATCH /api/bot/game-transfers/:id/status
 * The bot drives a CS-requested game credit transfer to its end state after
 * doing the real game-provider back-office move.
 *   - completed: credits are moved from_game → to_game atomically (validated
 *     under a row lock — the balance may have changed since the request).
 *   - failed: no credits move, nothing to reverse.
 * Only a "processing" transfer can transition; re-sending the same terminal
 * state is a 409.
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
      if (row.status !== "processing") {
        throw new BotError(409, `Transfer is "${row.status}", expected processing`);
      }

      const nowIso = new Date().toISOString();

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
        .set({ status: body.status })
        .where(eq(gameTransfers.transfer_id, transferId))
        .returning();

      const [player] = await txn
        .select({ company_entity_id: players.company_entity_id })
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

      return updated;
    });

    return Response.json({ transfer: gameTransferJson(result) });
  } catch (e) {
    return botErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

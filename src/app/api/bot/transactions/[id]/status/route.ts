import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  deposits,
  gameCredits,
  players,
  providerBoAccounts,
  transactions,
} from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { depositToBotJson, playerGameInfoMap } from "@/lib/bot-transactions";
import { BotError, botErrorResponse, jsonError } from "@/lib/bot-crud";

/** Allowed forward transitions the bot may drive. */
const ALLOWED: Record<string, string[]> = {
  pending_match: ["failed"],
  matched: ["approved", "processing", "completed", "failed"],
  pending: ["approved", "processing", "completed", "failed"],
  approved: ["processing", "completed", "failed"],
  processing: ["completed", "failed"],
  completed: [],
  failed: [],
};

const bodySchema = z.object({
  status: z.enum(["approved", "processing", "completed", "failed"]),
  game_topup_reference: z.string().max(80).optional(),
  note: z.string().max(500).optional(),
});

/**
 * PATCH /api/bot/transactions/:id/status
 * Update a deposit's status as the bot drives it through top-up.
 * `:id` is the numeric CRM id or the bot's external_id.
 *
 * The `completed` transition is where the CRM books the deposit — it credits
 * the player's game balance (+total), deducts the company BO pool (when one
 * exists), and bumps the player's total_deposits, all atomically. Every other
 * transition (approved/processing/failed) is a pure status change with no money
 * movement, so a `failed` top-up leaves nothing to reverse.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const numeric = Number(id);
  const [row] =
    Number.isInteger(numeric) && numeric > 0
      ? await db.select().from(deposits).where(eq(deposits.deposit_id, numeric))
      : await db.select().from(deposits).where(eq(deposits.external_id, id));

  if (!row) {
    return Response.json({ error: "Transaction not found" }, { status: 404 });
  }
  const gi = await playerGameInfoMap([row.player_id]);
  const player = row.player_id ? gi.get(row.player_id) : null;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      {
        error:
          "Provide status: approved | processing | completed | failed (optional game_topup_reference, note)",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (row.status === body.status) {
    // Idempotent no-op — re-sending the same status is safe (never re-credits).
    return Response.json({ transaction: depositToBotJson(row, player), unchanged: true });
  }

  const allowedTargets = ALLOWED[row.status] ?? [];
  if (!allowedTargets.includes(body.status)) {
    return Response.json(
      {
        error: `Cannot move "${row.status}" → "${body.status}"`,
        allowed_from_here: allowedTargets,
        transaction: depositToBotJson(row, player),
      },
      { status: 409 },
    );
  }

  try {
    const updated = await db.transaction(async (txn) => {
      // Re-read under a row lock so a concurrent complete/reprocess can't race.
      const [locked] = await txn
        .select()
        .from(deposits)
        .where(eq(deposits.deposit_id, row.deposit_id))
        .for("update");
      if (!locked) throw new BotError(404, "Transaction not found");
      if (locked.status === body.status) return locked; // already applied
      if (!(ALLOWED[locked.status] ?? []).includes(body.status)) {
        throw new BotError(409, `Cannot move "${locked.status}" → "${body.status}"`);
      }

      const nowIso = new Date().toISOString();

      // Book the ledger only when the top-up is confirmed completed.
      if (body.status === "completed" && locked.player_id && locked.selected_game) {
        if (locked.company_entity_id) {
          const [bo] = await txn
            .select()
            .from(providerBoAccounts)
            .where(
              and(
                eq(providerBoAccounts.company_entity_id, locked.company_entity_id),
                eq(providerBoAccounts.game_name, locked.selected_game),
                eq(providerBoAccounts.status, "active"),
              ),
            )
            .for("update");
          if (bo) {
            if (bo.current_credit < locked.total_amount) {
              throw new BotError(
                422,
                `Insufficient BO credit for ${locked.selected_game} (${bo.current_credit.toFixed(2)} available, ${locked.total_amount.toFixed(2)} needed)`,
              );
            }
            await txn
              .update(providerBoAccounts)
              .set({
                current_credit: +(bo.current_credit - locked.total_amount).toFixed(2),
              })
              .where(eq(providerBoAccounts.bo_account_id, bo.bo_account_id));
          }
        }

        await txn
          .insert(gameCredits)
          .values({
            player_id: locked.player_id,
            game_name: locked.selected_game,
            current_balance: locked.total_amount,
            last_updated_at: nowIso,
          })
          .onConflictDoUpdate({
            target: [gameCredits.player_id, gameCredits.game_name],
            set: {
              current_balance: sql`${gameCredits.current_balance} + ${locked.total_amount}`,
              last_updated_at: nowIso,
            },
          });

        await txn
          .update(players)
          .set({
            total_deposits: sql`${players.total_deposits} + ${locked.deposit_amount}`,
          })
          .where(eq(players.player_id, locked.player_id));

        await txn.insert(transactions).values({
          player_id: locked.player_id,
          type: "game_topup",
          amount: locked.total_amount,
          game_name: locked.selected_game,
          reference_id: locked.deposit_id,
          details: {
            source: "bot",
            topup_reference: body.game_topup_reference ?? locked.game_topup_reference ?? null,
          },
        });
      }

      const [saved] = await txn
        .update(deposits)
        .set({
          status: body.status,
          ...(body.game_topup_reference
            ? { game_topup_reference: body.game_topup_reference }
            : {}),
          updated_at: nowIso,
        })
        .where(eq(deposits.deposit_id, locked.deposit_id))
        .returning();

      await txn.insert(transactions).values({
        player_id: locked.player_id,
        type: "deposit",
        amount: locked.deposit_amount,
        game_name: locked.selected_game,
        reference_id: locked.deposit_id,
        details: {
          source: "bot",
          action: "status_update",
          api_key_label: auth.label,
          from: locked.status,
          to: body.status,
          game_topup_reference: body.game_topup_reference ?? null,
          note: body.note ?? null,
        },
      });

      return saved;
    });

    return Response.json({ transaction: depositToBotJson(updated, player) });
  } catch (e) {
    return botErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

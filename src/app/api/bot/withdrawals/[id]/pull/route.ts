import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { gameCredits, players, transactions, withdrawals } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { BotError, botErrorResponse, jsonError, withdrawalJson } from "@/lib/bot-crud";

/**
 * POST /api/bot/withdrawals/:id/pull — atomically deducts the player's game
 * balance (up to the requested amount) and moves the withdrawal to
 * credits_pulled. Same logic as the internal route, system-scoped.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const withdrawalId = Number(id);

  // Optional { amount }: what the agent really found in the wallet. Our
  // game_credits is a cache and can be behind, so a reported figure wins over
  // anything computed from it.
  const body = (await request.json().catch(() => null)) as { amount?: unknown } | null;
  const reported =
    typeof body?.amount === "number" && body.amount > 0 ? body.amount : null;

  try {
    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .for("update");
      if (!row) throw new BotError(404, "Withdrawal not found");
      if (row.status !== "requested") {
        throw new BotError(409, `Withdrawal is "${row.status}", expected requested`);
      }

      const [player] = await txn
        .select({ company_entity_id: players.company_entity_id })
        .from(players)
        .where(eq(players.player_id, row.player_id));

      const [credit] = await txn
        .select()
        .from(gameCredits)
        .where(
          and(
            eq(gameCredits.player_id, row.player_id),
            eq(gameCredits.game_name, row.game_name),
          ),
        )
        .for("update");
      const balance = credit?.current_balance ?? 0;
      // A withdraw-all takes the lot; a fixed request takes what it asked for,
      // capped by what is actually there.
      const pulled =
        reported ??
        (row.withdraw_all ? balance : Math.min(balance, row.requested_amount));
      if (pulled <= 0) {
        throw new BotError(422, `No ${row.game_name} balance to pull for this player`);
      }

      const nowIso = new Date().toISOString();
      await txn
        .update(gameCredits)
        .set({
          // A reported pull can exceed our cached figure — that is the point of
          // reporting it. The wallet is empty either way, never negative.
          current_balance: +Math.max(0, balance - pulled).toFixed(2),
          last_updated_at: nowIso,
        })
        .where(
          and(
            eq(gameCredits.player_id, row.player_id),
            eq(gameCredits.game_name, row.game_name),
          ),
        );

      const [updated] = await txn
        .update(withdrawals)
        .set({
          status: "credits_pulled",
          credit_pulled_amount: pulled,
          updated_at: nowIso,
        })
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .returning();

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: player?.company_entity_id ?? null,
        type: "credit_pull",
        amount: pulled,
        game_name: row.game_name,
        reference_id: row.withdrawal_id,
        details: {
          requested: row.requested_amount,
          balance_before: balance,
          source: "bot",
        },
      });

      return updated;
    });

    return Response.json({ withdrawal: withdrawalJson(result) });
  } catch (e) {
    return botErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

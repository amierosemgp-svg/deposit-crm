import { eq } from "drizzle-orm";
import { db } from "@/db";
import { gameCredits, players, transactions, withdrawals } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { creditWhere, resolveGameLogin } from "@/lib/game-credits";
import { jsonError } from "@/lib/api-helpers";

/**
 * POST /api/withdrawals/:id/pull — auto pull-back.
 * Atomically deducts the player's game balance (up to the requested amount)
 * and moves the withdrawal to credits_pulled.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const withdrawalId = Number(id);

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .for("update");
      if (!row) throw new AuthError(404, "Withdrawal not found");
      if (row.status !== "requested") {
        throw new AuthError(409, `Withdrawal is "${row.status}", expected requested`);
      }
      // Same rule as approving a deposit: claim it, then act. Pulling moves
      // real credit under your name, so it needs an owner.
      if (row.assigned_to_user_id !== user.user_id) {
        throw new AuthError(
          409,
          row.assigned_to_user_id
            ? "That withdrawal is handled by someone else"
            : "Assign this withdrawal to yourself before pulling credits",
        );
      }

      const [player] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, row.player_id));
      if (
        user.companyIds !== null &&
        !user.companyIds.includes(player.company_entity_id)
      ) {
        throw new AuthError(403, "Withdrawal is outside your company scope");
      }

      const login = resolveGameLogin(
        player?.game_accounts ?? null,
        row.game_name,
        row.game_username,
      );
      const [credit] = await txn
        .select()
        .from(gameCredits)
        .where(creditWhere(row.player_id, row.game_name, login))
        .for("update");
      const balance = credit?.current_balance ?? 0;
      // A withdraw-all takes the lot; a fixed request takes what it asked for,
      // capped by what is actually there.
      const pulled = row.withdraw_all
        ? balance
        : Math.min(balance, row.requested_amount);
      if (pulled <= 0) {
        throw new AuthError(422, `No ${row.game_name} balance to pull for this player`);
      }

      const nowIso = new Date().toISOString();
      await txn
        .update(gameCredits)
        .set({
          current_balance: +(balance - pulled).toFixed(2),
          last_updated_at: nowIso,
        })
        .where(creditWhere(row.player_id, row.game_name, login));

      const [updated] = await txn
        .update(withdrawals)
        .set({
          status: "credits_pulled",
          credit_pulled_amount: pulled,
          handled_by_user_id: user.user_id,
          updated_at: nowIso,
        })
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .returning();

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: player.company_entity_id,
        type: "credit_pull",
        amount: pulled,
        game_name: row.game_name,
        reference_id: row.withdrawal_id,
        user_id: user.user_id,
        details: { requested: row.requested_amount, balance_before: balance },
      });

      return updated;
    });

    return Response.json({ withdrawal: result });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

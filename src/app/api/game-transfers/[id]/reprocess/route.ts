import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { gameCredits, gameTransfers, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { MAX_TRANSFER_ATTEMPTS } from "@/lib/types";

/**
 * POST /api/game-transfers/:id/reprocess — put a failed transfer back in the
 * agent's queue.
 *
 * A failed transfer moved no credits, so this is a re-request, not a reversal:
 * the row goes back to "pending" with its attempt counter reset, and the agent
 * picks it up as if it were new. Re-queuing the same row rather than inserting a
 * new one keeps one transfer_id for what CS thinks of as one transfer; the
 * ledger below is what records that it was tried twice.
 *
 * The balance is re-validated, not assumed: the original check ran before the
 * failure, and the player's credits may well have moved since.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const transferId = Number(id);
    if (!Number.isInteger(transferId) || transferId <= 0) {
      return jsonError("Invalid transfer id");
    }

    const result = await db.transaction(async (txn) => {
      const [t] = await txn
        .select()
        .from(gameTransfers)
        .where(eq(gameTransfers.transfer_id, transferId))
        .for("update");
      if (!t) throw new AuthError(404, "Transfer not found");
      // Only a finished-and-failed transfer is safe to re-queue: one still in
      // flight is the agent's, and a completed one already moved the money.
      if (t.status !== "failed") {
        throw new AuthError(409, `Transfer is ${t.status}, not failed`);
      }

      const [player] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, t.player_id));
      if (!player) throw new AuthError(404, "Player not found");
      if (
        user.companyIds !== null &&
        !user.companyIds.includes(player.company_entity_id)
      ) {
        throw new AuthError(403, "Player is outside your company scope");
      }

      // Case-insensitive, matching the unique index on game_credits: the
      // transfer may have been recorded under a different spelling than the
      // balance row it is drawn from.
      const [fromCredit] = await txn
        .select()
        .from(gameCredits)
        .where(
          and(
            eq(gameCredits.player_id, t.player_id),
            sql`lower(${gameCredits.game_name}) = lower(${t.from_game})`,
          ),
        );
      const fromBalance = fromCredit?.current_balance ?? 0;
      // A transfer_all transfer carries no figure to check against — it is a
      // "whatever is in there" instruction, re-issued as one.
      if (!t.transfer_all && fromBalance < t.transfer_amount) {
        throw new AuthError(
          422,
          `Insufficient ${t.from_game} balance (${fromBalance.toFixed(2)}) — the transfer needs ${t.transfer_amount.toFixed(2)}`,
        );
      }

      const nowIso = new Date().toISOString();
      const [updated] = await txn
        .update(gameTransfers)
        .set({
          status: "pending",
          // A fresh request gets a fresh budget of attempts, and a fresh clock —
          // the stuck-transfer sweep measures from started_at.
          attempt_count: 1,
          started_at: nowIso,
          completed_at: null,
          note: null,
          // The old snapshot is from before the failure and is now misleading.
          from_game_balance_before: fromBalance,
          // A failed transfer_all attempt may have had a figure written onto it
          // by the agent; clear it so the retry is the same open instruction the
          // original was, not a fixed amount.
          ...(t.transfer_all ? { transfer_amount: 0 } : {}),
          handled_by_user_id: user.user_id,
        })
        .where(eq(gameTransfers.transfer_id, transferId))
        .returning();

      await txn.insert(transactions).values({
        player_id: t.player_id,
        entity_id: player.company_entity_id,
        type: "game_transfer",
        amount: t.transfer_amount,
        game_name: `${t.from_game} → ${t.to_game}`,
        reference_id: transferId,
        user_id: user.user_id,
        details: {
          action: "reprocess",
          from: t.from_game,
          to: t.to_game,
          transfer_all: t.transfer_all,
          previous_note: t.note,
          previous_attempts: t.attempt_count,
          max_attempts: MAX_TRANSFER_ATTEMPTS,
        },
      });

      return updated;
    });

    return Response.json({ transfer: result });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { referralBonuses, transactions } from "@/db/schema";

type Txn = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Undo what a credit-in claimed when its agent transfer fails.
 *
 * A credit-in (from_game === to_game) is a recommend bonus payout or a free
 * credit riding the agent's queue. Both are recorded as given the moment they
 * are queued — the bonus marked assigned, the free credit's ledger row written
 * — and nothing took that back when the agent failed, so every report counted
 * points no member received (bonuses #103 and #104, 44 points, 27 Oct).
 *
 *   recommend bonus  back to pending, unlinked from the transfer, so it shows
 *                    on the Recommend Bonus page to be paid again
 *   free credit      its row marked failed, so it stays on the sheet as Failed
 *                    and drops out of every free-credit total
 *
 * No balance moves either way: a failed transfer moved nothing. Safe to call
 * more than once; a second call finds nothing left to undo.
 */
export async function releaseFailedCreditIn(
  txn: Txn,
  transfer: {
    transfer_id: number;
    player_id: number;
    from_game: string;
    to_game: string;
  },
  reason: string,
): Promise<{ bonuses: number; freeCredits: number }> {
  if (transfer.from_game.toLowerCase() !== transfer.to_game.toLowerCase()) {
    return { bonuses: 0, freeCredits: 0 };
  }

  const released = await txn
    .update(referralBonuses)
    .set({
      status: "pending",
      game_transfer_id: null,
      assigned_by_user_id: null,
      assigned_at: null,
      note: `Bot failed on transfer #${transfer.transfer_id} (${reason}) — not paid, pay it again`,
    })
    .where(
      and(
        eq(referralBonuses.game_transfer_id, transfer.transfer_id),
        eq(referralBonuses.status, "assigned"),
      ),
    )
    .returning();
  for (const b of released) {
    await txn.insert(transactions).values({
      player_id: b.upline_player_id,
      type: "recommend_bonus",
      amount: -b.bonus_amount,
      game_name: b.game_name,
      reference_id: b.bonus_id,
      details: {
        action: "referral_bonus_released",
        source: "system",
        game_transfer_id: transfer.transfer_id,
        reason,
      },
    });
  }

  const marked = await txn
    .update(transactions)
    .set({
      details: sql`${transactions.details} || ${JSON.stringify({
        failed: true,
        failed_reason: reason,
      })}::jsonb`,
    })
    .where(
      and(
        eq(transactions.type, "game_topup"),
        sql`${transactions.details}->>'action' = 'free_credit'`,
        sql`${transactions.details}->>'game_transfer_id' = ${String(transfer.transfer_id)}`,
        sql`coalesce(${transactions.details}->>'failed', 'false') <> 'true'`,
      ),
    )
    .returning({ id: transactions.transaction_id });

  return { bonuses: released.length, freeCredits: marked.length };
}

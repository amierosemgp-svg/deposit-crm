import { and, desc, eq, sql } from "drizzle-orm";
import type { db } from "@/db";
import { deposits, referralBonuses, transactions } from "@/db/schema";
import { AuthError } from "@/lib/auth";
import { completeManualDeposit, reverseCompletedDeposit, syncCutoffForCompletion } from "@/lib/deposit-complete";
import { canonicalise } from "@/lib/game-name";
import { moveKioskCredit } from "@/lib/kiosk-credit";
import { syncReferralBonus } from "@/lib/referral";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What a staff error did to the deposit it was made on, kept on the penalty's
 * Staff Error ledger row so voiding the penalty can put it back.
 */
export type StaffErrorDepositEffect = {
  /** The penalty moved the deposit completed → failed. */
  deposit_failed: boolean;
  /** Kiosk credit the penalty moved on top of the unwind (negative = out). */
  kiosk_correction: number;
};

/**
 * A staff error on a deposit means the money never arrived but the credit
 * went out: a fake or double-keyed slip. So the deposit fails, and the bank
 * gives back what it was credited and total_deposits drops, as failing any
 * completed deposit does. The kiosk is the difference: an ordinary unwind
 * hands the float back the whole top-up, as though the credit never left,
 * but here the player spent it, and only what CS pulled back out of the game
 * returned. So the float is corrected down by the loss, leaving it up by just
 * the retrieved part.
 *
 * A deposit someone already failed by hand, the old way, gets the same kiosk
 * correction if that fail unwound a completion; a deposit rejected before it
 * was ever completed moved no credit, so there is nothing to correct.
 */
export async function failDepositForStaffError(
  txn: Tx,
  input: { depositId: number; loss: number; penaltyId: number; userId: number; nowIso: string },
): Promise<StaffErrorDepositEffect> {
  const { depositId, loss, penaltyId, userId, nowIso } = input;
  const [row] = await txn.select().from(deposits).where(eq(deposits.deposit_id, depositId)).for("update");
  if (!row) throw new AuthError(404, `No deposit #${depositId}`);
  const game = row.selected_game ? await canonicalise(row.selected_game, txn) : null;
  const correct = () => moveKioskCredit(txn, { companyEntityId: row.company_entity_id, gameName: game, delta: -loss });

  if (row.status === "failed") {
    if (!(await lastBookingWasUnwound(txn, depositId))) return { deposit_failed: false, kiosk_correction: 0 };
    await correct();
    return { deposit_failed: false, kiosk_correction: -loss };
  }
  if (row.status !== "completed") {
    throw new AuthError(409, `Deposit #${depositId} is ${row.status} — no credit has gone out on it yet`);
  }
  if (!row.skip_bot) {
    throw new AuthError(409, `Deposit #${depositId} was completed by the agent — only a manual deposit can be a staff error`);
  }
  // Same rule as failing it by hand: a paid recommend bonus is someone's money.
  const bonuses = await txn
    .select({ status: referralBonuses.status })
    .from(referralBonuses)
    .where(eq(referralBonuses.deposit_id, depositId));
  if (bonuses.some((b) => b.status === "assigned")) {
    throw new AuthError(409, `A recommend bonus on deposit #${depositId} has already been paid — cancel that payout first`);
  }

  const reversed = await reverseCompletedDeposit(txn, { row, nowIso });
  await txn.insert(transactions).values({
    player_id: row.player_id,
    entity_id: row.company_entity_id,
    type: "game_topup",
    amount: -row.total_amount,
    game_name: row.selected_game,
    reference_id: row.deposit_id,
    user_id: userId,
    details: {
      source: "manual",
      action: "reversed_on_fail",
      amount: row.deposit_amount,
      bonus: row.bonus_amount,
      received_into_account_id: row.received_into_account_id,
      wallet_reversed: reversed.walletReversed,
      staff_penalty_id: penaltyId,
      ...(reversed.negativeWallets.length ? { wallets_below_zero: reversed.negativeWallets } : {}),
    },
  });
  await correct();
  // handled_by stays the CS who keyed it: that is who the mistake was.
  await txn.update(deposits).set({ status: "failed", updated_at: nowIso }).where(eq(deposits.deposit_id, depositId));
  if (row.player_id !== null) await syncReferralBonus(txn, row.player_id);
  return { deposit_failed: true, kiosk_correction: -loss };
}

/** Voiding the penalty: the deposit goes back to how it stood before it. */
export async function undoStaffErrorOnDeposit(
  txn: Tx,
  input: { depositId: number; effect: StaffErrorDepositEffect; userId: number; nowIso: string },
): Promise<void> {
  const { depositId, effect, userId, nowIso } = input;
  if (!effect.deposit_failed && !effect.kiosk_correction) return;
  const [row] = await txn.select().from(deposits).where(eq(deposits.deposit_id, depositId)).for("update");
  if (!row) throw new AuthError(404, `No deposit #${depositId}`);
  if (effect.deposit_failed && row.status !== "failed") {
    throw new AuthError(409, `Deposit #${depositId} is ${row.status} now, not failed — sort it out by hand first`);
  }
  const game = row.selected_game ? await canonicalise(row.selected_game, txn) : null;
  // Back first, so re-completing has the float it took the first time.
  await moveKioskCredit(txn, {
    companyEntityId: row.company_entity_id,
    gameName: game,
    delta: -effect.kiosk_correction,
  });
  if (!effect.deposit_failed) return;
  const syncCutoffIso = await syncCutoffForCompletion(txn, row);
  await completeManualDeposit(txn, { row, userId, nowIso, syncCutoffIso });
  await txn
    .update(deposits)
    .set({ handled_by_user_id: row.handled_by_user_id })
    .where(eq(deposits.deposit_id, depositId));
  if (row.player_id !== null) await syncReferralBonus(txn, row.player_id);
}

/** Was the deposit's last booking a completion that a fail then unwound? */
async function lastBookingWasUnwound(txn: Tx, depositId: number): Promise<boolean> {
  const [last] = await txn
    .select({ details: transactions.details })
    .from(transactions)
    .where(
      and(
        eq(transactions.reference_id, depositId),
        eq(transactions.type, "game_topup"),
        sql`${transactions.details}->>'action' in ('manual_complete', 'reversed_on_fail')`,
      ),
    )
    .orderBy(desc(transactions.transaction_id))
    .limit(1);
  return (last?.details as { action?: string } | undefined)?.action === "reversed_on_fail";
}

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { deposits, players, referralBonuses } from "@/db/schema";

/** Share of a downline's first deposit that the upline earns. */
export const REFERRAL_BONUS_PERCENTAGE = 20;

type Txn = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Bring a downline's referral bonus in line with the facts, whichever order
 * they arrived in.
 *
 * The rule is one sentence: **the upline earns 20% of the downline's earliest
 * completed deposit.** Both halves can land in either order — CS often learns
 * about a referral after the player has already deposited — so this is called
 * from both the deposit-completion paths and from setting the upline, and
 * simply reconciles whatever is true now:
 *
 *   - upline + a completed deposit, no bonus yet  → create it (pending)
 *   - upline changed while still pending          → re-point it at the new upline
 *   - upline removed while still pending          → cancel it
 *   - already assigned                            → never touched; the credit
 *     has moved and un-paying it isn't this function's business
 *
 * Safe to call whenever either side changes; it no-ops when nothing should.
 */
export async function syncReferralBonus(
  txn: Txn,
  downlinePlayerId: number,
): Promise<void> {
  const [player] = await txn
    .select()
    .from(players)
    .where(eq(players.player_id, downlinePlayerId));
  if (!player) return;

  const [existing] = await txn
    .select()
    .from(referralBonuses)
    .where(eq(referralBonuses.downline_player_id, downlinePlayerId))
    .for("update");

  // Once the credit has gone out, this is history — leave it alone.
  if (existing && existing.status === "assigned") return;

  // The deposit the bonus is based on: their earliest completed one. Using
  // "earliest completed" rather than "the one just completed" is what makes
  // this work when the upline is set long after the player started depositing.
  const [firstDeposit] = player.upline_player_id
    ? await txn
        .select()
        .from(deposits)
        .where(
          and(
            eq(deposits.player_id, downlinePlayerId),
            eq(deposits.status, "completed"),
          ),
        )
        .orderBy(asc(deposits.deposit_date), asc(deposits.deposit_id))
        .limit(1)
    : [];

  // Nothing to pay: no upline, or nothing deposited yet.
  if (!player.upline_player_id || !firstDeposit) {
    if (existing && existing.status === "pending") {
      await txn
        .update(referralBonuses)
        .set({
          status: "cancelled",
          note: !player.upline_player_id
            ? "Upline removed before the bonus was assigned"
            : "No completed deposit for this downline",
        })
        .where(eq(referralBonuses.bonus_id, existing.bonus_id));
    }
    return;
  }

  // Bonus is on the deposit itself, not the bonused total — the house bonus
  // isn't the referrer's to take a cut of.
  const bonusAmount = +(
    (firstDeposit.deposit_amount * REFERRAL_BONUS_PERCENTAGE) /
    100
  ).toFixed(2);
  if (bonusAmount <= 0) return;

  if (existing) {
    // Pending, and something changed — re-point it rather than minting a
    // second row. One payout per downline, ever.
    await txn
      .update(referralBonuses)
      .set({
        upline_player_id: player.upline_player_id,
        deposit_id: firstDeposit.deposit_id,
        deposit_amount: firstDeposit.deposit_amount,
        bonus_percentage: REFERRAL_BONUS_PERCENTAGE,
        bonus_amount: bonusAmount,
        status: "pending",
        note: null,
      })
      .where(eq(referralBonuses.bonus_id, existing.bonus_id));
    return;
  }

  await txn
    .insert(referralBonuses)
    .values({
      upline_player_id: player.upline_player_id,
      downline_player_id: downlinePlayerId,
      deposit_id: firstDeposit.deposit_id,
      deposit_amount: firstDeposit.deposit_amount,
      bonus_percentage: REFERRAL_BONUS_PERCENTAGE,
      bonus_amount: bonusAmount,
      status: "pending",
    })
    // The unique constraint on downline_player_id is the real guard; this makes
    // a concurrent double-call a no-op rather than a 500.
    .onConflictDoNothing({ target: referralBonuses.downline_player_id });
}

/**
 * Called when a deposit completes. Resolves the deposit to its player, then
 * reconciles that player's bonus.
 */
export async function maybeCreateReferralBonus(
  txn: Txn,
  depositId: number,
): Promise<void> {
  const [deposit] = await txn
    .select({ player_id: deposits.player_id })
    .from(deposits)
    .where(eq(deposits.deposit_id, depositId));
  if (!deposit?.player_id) return;
  await syncReferralBonus(txn, deposit.player_id);
}

/** Would assigning `uplineId` to `playerId` create a loop in the referral tree? */
export async function wouldCycle(
  playerId: number,
  uplineId: number,
): Promise<boolean> {
  if (playerId === uplineId) return true;
  // Walk up from the proposed upline; if we meet the player, it's a cycle.
  // Bounded so a pre-existing loop in the data can't hang the request.
  let cursor: number | null = uplineId;
  for (let hops = 0; hops < 50 && cursor; hops++) {
    const [row] = await db
      .select({ upline: players.upline_player_id })
      .from(players)
      .where(eq(players.player_id, cursor));
    cursor = row?.upline ?? null;
    if (cursor === playerId) return true;
  }
  return false;
}

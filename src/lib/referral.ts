import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bonusPlans,
  deposits,
  gameCredits,
  players,
  providerBoAccounts,
  referralBonuses,
} from "@/db/schema";

/** Share of a downline's first deposit that the upline earns. */
export const REFERRAL_BONUS_PERCENTAGE = 20;

type Txn = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Bring a downline's referral bonus in line with the facts, whichever order
 * they arrived in.
 *
 * The rule: **the upline earns 20% of the downline's earliest completed deposit
 * that did not carry a welcome bonus.**
 *
 * A first deposit taking the welcome bonus is already being paid for once; the
 * house does not also pay the referrer for it. That does not cancel the
 * referral, it defers it — the downline's next completed deposit qualifies,
 * whatever bonus (if any) that one carries. Only the *welcome* type disqualifies:
 * a recurring or rebate bonus is unrelated to signing up.
 *
 * Both halves can land in either order — CS often learns about a referral after
 * the player has already deposited — so this is called from both the
 * deposit-completion paths and from setting the upline, and simply reconciles
 * whatever is true now:
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

  // The deposit the bonus is based on: their earliest completed one that did
  // not carry a welcome bonus. Using "earliest qualifying" rather than "the one
  // just completed" is what makes this work when the upline is set long after
  // the player started depositing.
  //
  // coalesce, not a plain <>: the join yields NULL both when the deposit has no
  // plan at all and when it points at a plan row that has since gone. Comparing
  // NULL to 'welcome' is NULL — falsy — so either case would silently drop a
  // deposit that ought to qualify.
  const [firstDeposit] = player.upline_player_id
    ? await txn
        .select({
          deposit_id: deposits.deposit_id,
          deposit_amount: deposits.deposit_amount,
        })
        .from(deposits)
        .leftJoin(bonusPlans, eq(bonusPlans.plan_id, deposits.bonus_plan_id))
        .where(
          and(
            eq(deposits.player_id, downlinePlayerId),
            eq(deposits.status, "completed"),
            sql`coalesce(${bonusPlans.type}::text, '') <> 'welcome'`,
          ),
        )
        .orderBy(asc(deposits.deposit_date), asc(deposits.deposit_id))
        .limit(1)
    : [];

  // Nothing to pay yet: no upline, or no deposit that qualifies.
  if (!player.upline_player_id || !firstDeposit) {
    if (existing && existing.status === "pending") {
      // Distinguish "there is nothing" from "there is one but it took the
      // welcome bonus" — the second is a wait, not a dead end, and CS reads
      // this note to know whether to expect it back.
      let reason = "No completed deposit for this downline";
      if (player.upline_player_id) {
        const [anyDeposit] = await txn
          .select({ id: deposits.deposit_id })
          .from(deposits)
          .where(
            and(
              eq(deposits.player_id, downlinePlayerId),
              eq(deposits.status, "completed"),
            ),
          )
          .limit(1);
        if (anyDeposit) {
          reason =
            "First deposit took the welcome bonus — the recommend bonus is earned on their next deposit";
        }
      }
      await txn
        .update(referralBonuses)
        .set({
          status: "cancelled",
          note: !player.upline_player_id
            ? "Upline removed before the bonus was assigned"
            : reason,
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

/**
 * Book a recommend bonus as free game credit, the same way a deposit top-up is
 * booked: the credit comes out of the company's wholesale BO pool for that
 * game and lands in the player's game balance.
 *
 * A bonus is a top-up minus the money — so unlike a deposit this deliberately
 * leaves `players.total_deposits` alone; nothing was deposited.
 *
 * A company with no active BO row for the game is credited anyway (matching the
 * deposit path): the pool is a mirror of the provider back-office, and refusing
 * to record credit CS has already moved would leave the CRM further from the
 * truth, not closer.
 *
 * Caller must hold whatever lock it needs on the bonus/transfer row — this only
 * locks the BO account it debits.
 */
export async function creditRecommendBonus(
  txn: Txn,
  {
    playerId,
    companyEntityId,
    gameName,
    amount,
    nowIso,
  }: {
    playerId: number;
    companyEntityId: number | null;
    gameName: string;
    amount: number;
    nowIso: string;
  },
): Promise<{ boDebited: boolean }> {
  let boDebited = false;

  if (companyEntityId !== null) {
    const [bo] = await txn
      .select()
      .from(providerBoAccounts)
      .where(
        and(
          eq(providerBoAccounts.company_entity_id, companyEntityId),
          eq(providerBoAccounts.game_name, gameName),
          eq(providerBoAccounts.status, "active"),
        ),
      )
      .for("update");
    if (bo) {
      if (bo.current_credit < amount) {
        throw new InsufficientBoCreditError(
          `Insufficient BO credit for ${gameName} (${bo.current_credit.toFixed(2)} available, ${amount.toFixed(2)} needed)`,
        );
      }
      await txn
        .update(providerBoAccounts)
        .set({ current_credit: +(bo.current_credit - amount).toFixed(2) })
        .where(eq(providerBoAccounts.bo_account_id, bo.bo_account_id));
      boDebited = true;
    }
  }

  await txn
    .insert(gameCredits)
    .values({
      player_id: playerId,
      game_name: gameName,
      current_balance: amount,
      last_updated_at: nowIso,
    })
    .onConflictDoUpdate({
      target: [gameCredits.player_id, gameCredits.game_name],
      set: {
        current_balance: sql`${gameCredits.current_balance} + ${amount}`,
        last_updated_at: nowIso,
      },
    });

  return { boDebited };
}

/** Thrown by creditRecommendBonus so each caller can map it to its own status. */
export class InsufficientBoCreditError extends Error {}

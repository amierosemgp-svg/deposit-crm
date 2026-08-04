import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { deposits, players, referralBonuses } from "@/db/schema";

/** Share of a downline's first deposit that the upline earns. */
export const REFERRAL_BONUS_PERCENTAGE = 20;

type Txn = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Mint the upline's referral bonus when a downline's **first** deposit
 * completes. Safe to call on every completion — it no-ops otherwise.
 *
 * Must be called inside the same transaction that completes the deposit, so a
 * bonus can never exist for a deposit that then rolls back.
 *
 * "First" means no other completed deposit exists for that player. Checking
 * completions rather than a counter means a deposit that later fails doesn't
 * leave a phantom bonus behind, and re-running this for the same player is
 * caught by the unique constraint on downline_player_id either way.
 */
export async function maybeCreateReferralBonus(
  txn: Txn,
  depositId: number,
): Promise<void> {
  const [deposit] = await txn
    .select()
    .from(deposits)
    .where(eq(deposits.deposit_id, depositId));
  if (!deposit?.player_id) return;

  const [player] = await txn
    .select()
    .from(players)
    .where(eq(players.player_id, deposit.player_id));
  // No upline means nobody to pay.
  if (!player?.upline_player_id) return;

  // Any *other* completed deposit means this isn't their first.
  const [{ count }] = await txn
    .select({ count: sql<number>`count(*)::int` })
    .from(deposits)
    .where(
      and(
        eq(deposits.player_id, deposit.player_id),
        eq(deposits.status, "completed"),
        ne(deposits.deposit_id, depositId),
      ),
    );
  if (count > 0) return;

  const bonusAmount = +(
    (deposit.deposit_amount * REFERRAL_BONUS_PERCENTAGE) /
    100
  ).toFixed(2);
  if (bonusAmount <= 0) return;

  await txn
    .insert(referralBonuses)
    .values({
      upline_player_id: player.upline_player_id,
      downline_player_id: player.player_id,
      deposit_id: deposit.deposit_id,
      // Bonus is on the deposit itself, not the bonused total — the house
      // bonus isn't the referrer's to take a cut of.
      deposit_amount: deposit.deposit_amount,
      bonus_percentage: REFERRAL_BONUS_PERCENTAGE,
      bonus_amount: bonusAmount,
      status: "pending",
    })
    // The unique constraint on downline_player_id is the real guard; this just
    // makes a repeat a silent no-op rather than a 500.
    .onConflictDoNothing({ target: referralBonuses.downline_player_id });
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

import { db } from "@/db";
import { eq, sql } from "drizzle-orm";
import { gameTransfers, players, settings, transactions } from "@/db/schema";
import { AuthError, type AuthedUser } from "@/lib/auth";
import { creditRecommendBonus, InsufficientBoCreditError } from "@/lib/referral";
import { resolveGameLogin } from "@/lib/game-credits";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PlayerRow = typeof players.$inferSelect;

/**
 * Inject game credit with no deposit behind it — a rebate, a goodwill credit,
 * a promo. The one path the Free Credit sheet and the Rebates page both ride.
 *
 * Two rails, same as a referral-bonus payout:
 *   - skipBot: CS credited the game in the provider back-office themselves —
 *     the player's balance and the company BO pool are booked here and now.
 *   - otherwise: a credit-in game transfer (from_game === to_game) is queued;
 *     the balance moves when the agent reports it completed.
 *
 * Either way one `game_topup` audit row with details.action = "free_credit" is
 * written — that row IS the Free Credit ledger, so a queued agent credit shows
 * the moment it's entered. Throws AuthError with the right status when the
 * player has no such game or the BO pool can't cover a hand credit.
 */
export async function issueFreeCredit(
  txn: Tx,
  input: {
    user: AuthedUser;
    player: PlayerRow;
    gameName: string;
    /** Which login under the game. Omit for the player's first account. */
    gameUsername?: string | null;
    amount: number;
    reason?: string | null;
    skipBot: boolean;
    /** Extra ledger details — e.g. which rebate payout this credit settles. */
    details?: Record<string, unknown>;
  },
): Promise<{ transactionId: number; gameTransferId: number | null; gameUsername: string }> {
  const { user, player, gameName, amount, reason, skipBot } = input;

  // Credit has to land in an account the player actually holds, or it goes
  // nowhere the player can reach.
  const hasGame = (player.game_accounts ?? []).some(
    (g) => g.game_name.toLowerCase() === gameName.toLowerCase(),
  );
  if (!hasGame) {
    throw new AuthError(422, `${player.username} has no ${gameName} account linked`);
  }

  await assertWithinMonthlyCap(txn, player.company_entity_id, amount);

  const login = resolveGameLogin(player.game_accounts, gameName, input.gameUsername);
  const nowIso = new Date().toISOString();
  let gameTransferId: number | null = null;

  if (skipBot) {
    // Same booking as a hand-credited referral bonus: player balance up,
    // company BO pool down. Fails cleanly when the pool can't cover it.
    try {
      await creditRecommendBonus(txn, {
        playerId: player.player_id,
        companyEntityId: player.company_entity_id,
        gameName,
        gameUsername: login,
        amount,
        nowIso,
      });
    } catch (e) {
      if (e instanceof InsufficientBoCreditError) throw new AuthError(422, e.message);
      throw e;
    }
  } else {
    // Queue it for the agent. from_game === to_game marks a credit-in — the
    // same shape the referral payout uses, so the agent, the stall sweep and
    // the Game Credit Transfer page all handle it unchanged.
    const [transfer] = await txn
      .insert(gameTransfers)
      .values({
        player_id: player.player_id,
        from_game: gameName,
        to_game: gameName,
        from_game_username: login,
        to_game_username: login,
        transfer_amount: amount,
        from_game_balance_before: 0,
        status: "pending",
        started_at: nowIso,
        handled_by_user_id: user.user_id,
        note: `Free credit${reason ? ` — ${reason}` : ""}`,
      })
      .returning();
    gameTransferId = transfer.transfer_id;
  }

  const [audit] = await txn
    .insert(transactions)
    .values({
      player_id: player.player_id,
      entity_id: player.company_entity_id,
      type: "game_topup",
      amount,
      game_name: gameName,
      reference_id: gameTransferId,
      user_id: user.user_id,
      details: {
        action: "free_credit",
        source: skipBot ? "manual" : "bot",
        game_username: login,
        reason: reason ?? null,
        game_transfer_id: gameTransferId,
        ...(input.details ?? {}),
      },
    })
    .returning();

  return { transactionId: audit.transaction_id, gameTransferId, gameUsername: login };
}


/** Share of the month's deposits that may be given away as free credit. */
export const DEFAULT_FREE_CREDIT_CAP_PCT = 3;

/**
 * Free credit is capped at a share of what the company took in that month.
 *
 * Without a ceiling it is the one payout with no natural limit: a bonus is a
 * percentage of a deposit and a rebate is a share of a measured loss, but a
 * free credit is whatever someone types. The cap ties it back to the month's
 * own takings, so a quiet month cannot be given away.
 *
 * Measured over the calendar month in business time, against every free credit
 * already issued in it — rebates and promos included, since they all spend the
 * same allowance. The percentage lives in settings (`free_credit_cap_pct`) so
 * it can be changed without a deploy; 0 disables the check.
 */
async function assertWithinMonthlyCap(
  txn: Tx,
  companyEntityId: number | null,
  amount: number,
): Promise<void> {
  if (companyEntityId === null) return;

  const [row] = await txn
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "free_credit_cap_pct"));
  const pct =
    typeof row?.value === "number" ? row.value : DEFAULT_FREE_CREDIT_CAP_PCT;
  if (pct <= 0) return;

  const month = sql`date_trunc('month', (now() AT TIME ZONE 'Asia/Kuala_Lumpur'))::date`;
  const [totals] = (await txn.execute(sql`
    SELECT
      coalesce((SELECT sum(d.deposit_amount) FROM deposits d
                 WHERE d.company_entity_id = ${companyEntityId}
                   AND d.status <> 'failed'
                   AND (d.deposit_date AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= ${month}), 0)::float8
        AS deposits,
      coalesce((SELECT sum(t.amount) FROM transactions t
                 WHERE t.entity_id = ${companyEntityId}
                   AND t.type = 'game_topup'
                   AND t.details->>'action' = 'free_credit'
                   AND (t.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= ${month}), 0)::float8
        AS issued
  `)).rows as unknown as { deposits: number; issued: number }[];

  const allowance = +(((totals?.deposits ?? 0) * pct) / 100).toFixed(2);
  const used = totals?.issued ?? 0;
  const left = +(allowance - used).toFixed(2);

  if (amount > left) {
    throw new AuthError(
      422,
      `Free credit for this month is capped at ${pct}% of deposits — ` +
        `RM ${allowance.toFixed(2)} allowed, RM ${used.toFixed(2)} already issued, ` +
        `RM ${Math.max(left, 0).toFixed(2)} left`,
    );
  }
}

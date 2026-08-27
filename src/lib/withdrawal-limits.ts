import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { deposits, referralBonuses, settings } from "@/db/schema";

type Runner = Pick<typeof db, "select">;

/** Setting key; 0 or absent means "no minimum". */
const MIN_WITHDRAWAL_KEY = "min_withdrawal_amount";

export async function loadMinWithdrawal(runner: Runner = db): Promise<number> {
  const [row] = await runner
    .select()
    .from(settings)
    .where(eq(settings.key, MIN_WITHDRAWAL_KEY));
  const value = typeof row?.value === "number" ? row.value : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Bonus credit sitting in a player's game wallet.
 *
 * A completed deposit credits `total_amount` — the deposit *plus* its bonus —
 * so `game_credits.current_balance` is not all the player's own money. Both
 * sources of house money are counted:
 *   - a deposit's own bonus (`deposits.bonus_amount`), and
 *   - a recommend bonus credited into this game (`referral_bonuses`, assigned
 *     only; pending ones have not been paid and cancelled ones never will be).
 *
 * Case-insensitive on the game name, matching the unique index on game_credits:
 * a bonus booked as "918kiss" belongs to the same wallet as "918Kiss".
 */
export async function bonusCreditInWallet(
  runner: Runner,
  playerId: number,
  gameName: string,
): Promise<number> {
  const [dep] = await runner
    .select({
      total: sql<string | null>`coalesce(sum(${deposits.bonus_amount}), 0)`,
    })
    .from(deposits)
    .where(
      and(
        eq(deposits.player_id, playerId),
        eq(deposits.status, "completed"),
        sql`lower(${deposits.selected_game}) = lower(${gameName})`,
      ),
    );

  const [rec] = await runner
    .select({
      total: sql<string | null>`coalesce(sum(${referralBonuses.bonus_amount}), 0)`,
    })
    .from(referralBonuses)
    .where(
      and(
        eq(referralBonuses.upline_player_id, playerId),
        eq(referralBonuses.status, "assigned"),
        sql`lower(${referralBonuses.game_name}) = lower(${gameName})`,
      ),
    );

  return +(Number(dep?.total ?? 0) + Number(rec?.total ?? 0)).toFixed(2);
}

export type WithdrawalCheck =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Is this player's wallet above the configured minimum, counting only their own
 * money?
 *
 * The rule is `balance − bonus >= minimum`. Bonus credit is house money the
 * player has not earned out, so a wallet that only looks big because of a
 * welcome bonus does not qualify.
 *
 * Returns ok when no minimum is configured, so this is inert until an admin
 * sets one.
 */
export async function checkWithdrawalMinimum(
  runner: Runner,
  input: { playerId: number; gameName: string; balance: number },
): Promise<WithdrawalCheck> {
  const minimum = await loadMinWithdrawal(runner);
  if (minimum <= 0) return { ok: true };

  const bonus = await bonusCreditInWallet(runner, input.playerId, input.gameName);
  const own = +(input.balance - bonus).toFixed(2);
  if (own >= minimum) return { ok: true };

  return {
    ok: false,
    message:
      `Below the RM ${minimum.toFixed(2)} minimum: ${input.gameName} holds ` +
      `RM ${input.balance.toFixed(2)}, of which RM ${bonus.toFixed(2)} is bonus credit — ` +
      `RM ${own.toFixed(2)} withdrawable.`,
  };
}

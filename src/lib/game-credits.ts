import { and, eq, sql, type SQL } from "drizzle-orm";
import { gameCredits } from "@/db/schema";
import type { PlayerGameAccount } from "./types";

/**
 * Per-login game balances.
 *
 * game_credits keys on (player_id, game_name, game_username) — a player may
 * hold several logins under one game and each carries its own balance. This
 * module is the one place that decides *which* login a money move targets and
 * builds the case-insensitive match against the balance row, so every call
 * site resolves it the same way.
 */

/**
 * The login a game operation acts on. An explicit username wins; otherwise the
 * player's FIRST linked account for that game (the pre-multi-account default);
 * otherwise "" — the legacy/only-login row. Mirrors the migration's backfill,
 * so a record saved before this feature resolves to the same balance row it
 * always used.
 */
export function resolveGameLogin(
  gameAccounts: PlayerGameAccount[] | null | undefined,
  gameName: string,
  explicit?: string | null,
): string {
  const e = explicit?.trim();
  if (e) return e;
  const acct = (gameAccounts ?? []).find(
    (a) => a.game_name.toLowerCase() === gameName.toLowerCase(),
  );
  return acct?.game_username ?? "";
}

/**
 * Case-insensitive WHERE for one login's balance row. Both game and login are
 * matched loosely so a spelling variant can't fork a balance — the unique
 * index game_credits_player_game_login_ci_idx enforces the same.
 */
export function creditWhere(
  playerId: number,
  gameName: string,
  gameUsername: string,
): SQL {
  return and(
    eq(gameCredits.player_id, playerId),
    sql`lower(${gameCredits.game_name}) = lower(${gameName})`,
    sql`lower(${gameCredits.game_username}) = lower(${gameUsername})`,
  )!;
}

/** The three PK columns, for onConflictDoUpdate targets. */
export const CREDIT_CONFLICT_TARGET = [
  gameCredits.player_id,
  gameCredits.game_name,
  gameCredits.game_username,
] as const;

/**
 * Move credit between two of a player's wallets, inside a transaction.
 *
 * Extracted from the agent's completion handler so the manual rail books a
 * transfer exactly the way the agent does. Two call sites writing this by hand
 * is how the same transfer ends up debiting one balance and crediting another
 * that spelling drift has forked in two.
 *
 * Locks the source row, re-reads it (the cached figure the request was made
 * against may have moved), and writes back under the spelling already on file
 * so a case variant can't fork the balance the unique index forbids. Returns
 * what actually moved.
 */
export async function moveGameCredit(
  txn: {
    select: typeof import("@/db").db.select;
    update: typeof import("@/db").db.update;
    insert: typeof import("@/db").db.insert;
  },
  input: {
    playerId: number;
    fromGame: string;
    fromLogin: string;
    toGame: string;
    toLogin: string;
    /** Null with `all` — the whole source balance, whatever it turns out to be. */
    amount: number | null;
    all?: boolean;
    nowIso: string;
  },
): Promise<number> {
  const { playerId, fromGame, fromLogin, toGame, toLogin, nowIso } = input;

  const [fromCredit] = await txn
    .select()
    .from(gameCredits)
    .where(creditWhere(playerId, fromGame, fromLogin))
    .for("update");
  const fromBalance = fromCredit?.current_balance ?? 0;

  const moved = input.all ? fromBalance : (input.amount ?? 0);
  if (moved <= 0) {
    throw new InsufficientCreditError(
      `Nothing to transfer from ${fromGame} (balance ${fromBalance.toFixed(2)})`,
    );
  }
  if (fromBalance < moved) {
    throw new InsufficientCreditError(
      `Insufficient ${fromGame} balance (${fromBalance.toFixed(2)} available, ${moved.toFixed(2)} needed)`,
    );
  }

  const fromName = fromCredit?.game_name ?? fromGame;
  const fromUser = fromCredit?.game_username ?? fromLogin;
  await txn
    .update(gameCredits)
    .set({
      current_balance: +(fromBalance - moved).toFixed(2),
      last_updated_at: nowIso,
    })
    .where(
      and(
        eq(gameCredits.player_id, playerId),
        eq(gameCredits.game_name, fromName),
        eq(gameCredits.game_username, fromUser),
      ),
    );

  // Resolve the destination's existing spelling before upserting, or the
  // case-sensitive primary key misses the conflict and the case-insensitive
  // unique index rejects the insert outright.
  const [toCredit] = await txn
    .select({
      game_name: gameCredits.game_name,
      game_username: gameCredits.game_username,
    })
    .from(gameCredits)
    .where(creditWhere(playerId, toGame, toLogin))
    .for("update");
  await txn
    .insert(gameCredits)
    .values({
      player_id: playerId,
      game_name: toCredit?.game_name ?? toGame,
      game_username: toCredit?.game_username ?? toLogin,
      current_balance: moved,
      last_updated_at: nowIso,
    })
    .onConflictDoUpdate({
      target: [...CREDIT_CONFLICT_TARGET],
      set: {
        current_balance: sql`${gameCredits.current_balance} + ${moved}`,
        last_updated_at: nowIso,
      },
    });

  return moved;
}

/** The source wallet can't cover the move. Callers map this to a 422. */
export class InsufficientCreditError extends Error {}

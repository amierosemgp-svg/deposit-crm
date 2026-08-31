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

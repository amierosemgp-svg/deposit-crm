import { and, eq, sql, type SQL } from "drizzle-orm";
import { gameCredits } from "@/db/schema";
import { moveKioskCredit } from "./kiosk-credit";
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

/**
 * Add to or take from one wallet, and report where it ended up.
 *
 * For corrections rather than transactions: re-booking a deposit that was
 * recorded wrong has to undo a credit that has already been written. Unlike
 * moveGameCredit this does not refuse to go negative — the correction is the
 * truth, and a balance that ends below zero says the cached figure and the
 * provider have parted company, which is worth showing rather than rounding
 * away. Callers surface that to CS.
 */
export async function adjustGameCredit(
  txn: {
    select: typeof import("@/db").db.select;
    insert: typeof import("@/db").db.insert;
  },
  input: {
    playerId: number;
    gameName: string;
    gameUsername: string;
    delta: number;
    nowIso: string;
  },
): Promise<number> {
  const { playerId, gameName, gameUsername, delta, nowIso } = input;
  if (delta === 0) return 0;

  const [existing] = await txn
    .select()
    .from(gameCredits)
    .where(creditWhere(playerId, gameName, gameUsername))
    .for("update");

  const next = +((existing?.current_balance ?? 0) + delta).toFixed(2);
  await txn
    .insert(gameCredits)
    .values({
      player_id: playerId,
      // Write back under the spelling already on file, so a case variant can't
      // fork the balance the unique index forbids.
      game_name: existing?.game_name ?? gameName,
      game_username: existing?.game_username ?? gameUsername,
      current_balance: next,
      last_updated_at: nowIso,
    })
    .onConflictDoUpdate({
      target: [...CREDIT_CONFLICT_TARGET],
      set: { current_balance: next, last_updated_at: nowIso },
    });
  return next;
}

/** One leg of a re-booking: a player's wallet, or a company's kiosk float. */
export type CreditLeg =
  | {
      kind: "wallet";
      playerId: number;
      gameName: string;
      login: string;
      /** Positive = into the player's wallet, negative = out of it. */
      delta: number;
    }
  | {
      kind: "kiosk";
      companyEntityId: number | null;
      gameName: string;
      /** Positive = back into the float, negative = spent from it. */
      delta: number;
    };

/**
 * Lay down a set of credit movements as one netted booking.
 *
 * For correcting a manual row after it has already booked: the edit is "take
 * the old booking out, put the new one in", and written leg by leg that would
 * debit a kiosk for the full new figure before crediting the old one back —
 * refusing a 500 → 510 correction for want of 510 in a float that only has to
 * find 10. So every leg is netted first, per wallet and per float, and an
 * unchanged game nets to the difference. Same approach rebookCompletedDeposit
 * takes, for the same reason.
 *
 * Floats move through moveKioskCredit, so a debit the float cannot cover
 * throws InsufficientKioskCreditError and the caller's transaction rolls back.
 * Wallets move through adjustGameCredit, which does not refuse to go negative —
 * the correction is the truth, and a wallet that ends below zero is reported
 * back so CS can sync the kiosk rather than have it rounded away.
 */
export async function applyCreditRebook(
  txn: Pick<typeof import("@/db").db, "select" | "insert" | "update">,
  legs: CreditLeg[],
  nowIso: string,
): Promise<{ negativeWallets: Array<{ game: string; login: string; balance: number }> }> {
  const kiosk = new Map<string, { companyEntityId: number; gameName: string; delta: number }>();
  const wallet = new Map<
    string,
    { playerId: number; gameName: string; login: string; delta: number }
  >();

  for (const leg of legs) {
    if (leg.delta === 0 || !leg.gameName) continue;
    if (leg.kind === "kiosk") {
      if (leg.companyEntityId === null) continue;
      const key = `${leg.companyEntityId}::${leg.gameName.toLowerCase()}`;
      const at = kiosk.get(key) ?? {
        companyEntityId: leg.companyEntityId,
        gameName: leg.gameName,
        delta: 0,
      };
      at.delta = +(at.delta + leg.delta).toFixed(2);
      kiosk.set(key, at);
    } else {
      const key = `${leg.playerId}::${leg.gameName.toLowerCase()}::${leg.login.toLowerCase()}`;
      const at = wallet.get(key) ?? {
        playerId: leg.playerId,
        gameName: leg.gameName,
        login: leg.login,
        delta: 0,
      };
      at.delta = +(at.delta + leg.delta).toFixed(2);
      wallet.set(key, at);
    }
  }

  // Returns before spends: a float being credited back is never the one that
  // refuses, and doing them first keeps the lock order predictable.
  const floats = [...kiosk.values()].sort((a, b) => b.delta - a.delta);
  for (const k of floats) {
    await moveKioskCredit(txn, {
      companyEntityId: k.companyEntityId,
      gameName: k.gameName,
      delta: k.delta,
    });
  }

  const negativeWallets: Array<{ game: string; login: string; balance: number }> = [];
  for (const w of wallet.values()) {
    if (w.delta === 0) continue;
    const balance = await adjustGameCredit(txn, {
      playerId: w.playerId,
      gameName: w.gameName,
      gameUsername: w.login,
      delta: w.delta,
      nowIso,
    });
    if (balance < 0) negativeWallets.push({ game: w.gameName, login: w.login, balance });
  }
  return { negativeWallets };
}

/**
 * Whether the player actually holds this login under this game.
 *
 * An empty login is the legacy/only-login row and always passes — it is what
 * resolveGameLogin falls back to for a player with no linked account names.
 * A named one has to be on the player's list, or a correction would credit a
 * wallet nobody can reach.
 */
/**
 * The login to keep when a row moves to another game: the current one if the
 * member holds it on that game, otherwise their own login for it, otherwise
 * null ("the member's first account for the game").
 *
 * The sheet edits one cell at a time, so moving a row from Mega888 to 918Kiss
 * sent the game alone and kept the Mega888 login — which isn't a 918Kiss login,
 * so the edit was refused; and editing the login first was refused against the
 * old game. Neither cell could ever change.
 */
export function loginForGame(
  gameAccounts: PlayerGameAccount[] | null | undefined,
  gameName: string,
  current: string | null | undefined,
): string | null {
  if (current && holdsGameLogin(gameAccounts, gameName, current)) return current;
  return (
    (gameAccounts ?? []).find((a) => a.game_name.toLowerCase() === gameName.toLowerCase())
      ?.game_username ?? null
  );
}

export function holdsGameLogin(
  gameAccounts: PlayerGameAccount[] | null | undefined,
  gameName: string,
  login: string,
): boolean {
  if (!login) return true;
  return (gameAccounts ?? []).some(
    (a) =>
      a.game_name.toLowerCase() === gameName.toLowerCase() &&
      (a.game_username ?? "").toLowerCase() === login.toLowerCase(),
  );
}

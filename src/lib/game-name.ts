import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { settings, transactions } from "@/db/schema";
import type { PlayerGameAccount } from "./types";

/**
 * Fallback catalogue, mirroring the store's. Only used if the `games` setting
 * is missing — a fresh database before anyone has configured it.
 */
export const DEFAULT_GAME_CATALOGUE = [
  "Mega888",
  "Pussy888",
  "918Kiss",
  "XE88",
];

/**
 * The house's game list, in its canonical spelling.
 *
 * Cached per request-ish: a module-level memo would go stale when someone edits
 * the setting, and the read is a single indexed row, so it isn't worth it.
 */
export async function loadGameCatalogue(
  runner: Pick<typeof db, "select"> = db,
): Promise<string[]> {
  const [row] = await runner
    .select()
    .from(settings)
    .where(eq(settings.key, "games"));
  const value = row?.value;
  if (Array.isArray(value)) {
    const names = value.filter((v): v is string => typeof v === "string");
    if (names.length) return names;
  }
  return DEFAULT_GAME_CATALOGUE;
}

/**
 * Resolve a game name to the catalogue's spelling.
 *
 * Postgres is case-sensitive, and `game_credits` is keyed on
 * (player_id, game_name) — so an agent posting "918kiss" while the CRM used
 * "918Kiss" silently created a *second* balance for the same real account, and
 * the player's money was split across two rows nobody was adding up. Every
 * write goes through here so that can't happen twice.
 *
 * Matching is case-insensitive but nothing more: "918kiss2" is a genuinely
 * different game from "918Kiss" and must never be folded into it. An unknown
 * name is trimmed and kept as given — this normalises spelling, it does not
 * police the catalogue.
 */
export function canonicalGameName(name: string, catalogue: string[]): string {
  const trimmed = name.trim();
  const match = catalogue.find(
    (g) => g.toLowerCase() === trimmed.toLowerCase(),
  );
  return match ?? trimmed;
}

/** Convenience: canonicalise against the stored catalogue in one call. */
export async function canonicalise(
  name: string,
  runner: Pick<typeof db, "select"> = db,
): Promise<string> {
  return canonicalGameName(name, await loadGameCatalogue(runner));
}

export class DuplicateGameAccountError extends Error {
  constructor(public games: string[]) {
    super(
      games.length === 1
        ? `This player already has a ${games[0]} account — one account per game.`
        : `Duplicate game accounts: ${games.join(", ")}. A player gets one account per game.`,
    );
  }
}

/**
 * Canonicalise a player's game accounts and enforce one per game.
 *
 * A second account on the same game is not a richer record, it is an ambiguity:
 * every top-up, transfer and credit-pull then has two candidate logins and
 * picks whichever the lookup happens to return first. Rejecting the write is
 * the only answer that keeps `game_accounts` meaning what the rest of the
 * system assumes it means.
 *
 * Throws DuplicateGameAccountError naming the offending games, so the message
 * tells whoever sent it which line to fix.
 */
export function normaliseGameAccounts(
  accounts: PlayerGameAccount[],
  catalogue: string[],
): PlayerGameAccount[] {
  const out: PlayerGameAccount[] = [];
  const seen = new Map<string, string>();
  const clashes: string[] = [];

  for (const a of accounts) {
    const game_name = canonicalGameName(a.game_name, catalogue);
    const key = game_name.toLowerCase();
    if (seen.has(key)) {
      // Two spellings of one game count as one clash, reported canonically.
      if (!clashes.includes(game_name)) clashes.push(game_name);
      continue;
    }
    seen.set(key, game_name);
    out.push({ game_name, game_username: a.game_username.trim() });
  }

  if (clashes.length) throw new DuplicateGameAccountError(clashes);
  return out;
}

/**
 * Did the agent already sync this game's real balance since `sinceIso`?
 *
 * `POST /api/bot/game-credits` writes an absolute figure read off the provider;
 * a deposit completion adds a delta the CRM believes it caused. When the agent
 * tops the game up, syncs the new balance, *then* reports the deposit complete,
 * both describe the same money — and applying the delta on top of ground truth
 * doubled every balance (26 times across 6 accounts before this was caught).
 *
 * The sync wins: after it, the CRM's belief already equals the provider's, so
 * the delta is redundant by definition. Callers skip their credit when this
 * returns a row, and say so in the ledger rather than silently doing nothing.
 */
export async function balanceSyncedSince(
  runner: Pick<typeof db, "select">,
  input: { playerId: number; gameName: string; sinceIso: string },
): Promise<{ created_at: string; balance_after: unknown } | null> {
  const [row] = await runner
    .select({
      created_at: transactions.created_at,
      details: transactions.details,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.player_id, input.playerId),
        eq(transactions.type, "bo_adjustment"),
        sql`${transactions.details}->>'action' = 'balance_sync'`,
        // Case-insensitive: the sync that caused this bug was spelled
        // differently from the deposit's own game.
        sql`lower(${transactions.game_name}) = lower(${input.gameName})`,
        gte(transactions.created_at, input.sinceIso),
      ),
    )
    .orderBy(desc(transactions.created_at))
    .limit(1);

  if (!row) return null;
  return {
    created_at: row.created_at,
    balance_after: (row.details as Record<string, unknown> | null)?.balance_after ?? null,
  };
}

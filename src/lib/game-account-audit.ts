import { gameAccountAudit } from "@/db/schema";
import { db } from "@/db";

export type GameAccount = { game_name: string; game_username: string };

/** Anything that can run an insert — the pool, or a caller's open transaction. */
type Executor = Pick<typeof db, "insert">;

/**
 * Record what changed between two game_accounts lists.
 *
 * players.game_accounts is a jsonb array rewritten wholesale on every edit, so
 * an update that drops an account leaves no trace of what was there. After a
 * top-up goes to the wrong place the question is always "who changed this id,
 * and what was it before" — this is what answers it.
 *
 * Diffed by game_name, which is the identity of a player's account within a
 * provider: same game with a different username is an update, not a
 * remove-plus-add.
 */
export async function recordGameAccountChanges(
  playerId: number,
  before: GameAccount[] | null,
  after: GameAccount[] | null,
  by: { userId?: number | null; source?: "bot" | "manual" } = {},
  // Pass the open transaction when the change is part of one, so the audit row
  // rolls back with it rather than outliving a failed assignment.
  executor: Executor = db,
): Promise<void> {
  const prev = new Map((before ?? []).map((g) => [g.game_name, g.game_username]));
  const next = new Map((after ?? []).map((g) => [g.game_name, g.game_username]));

  const rows: (typeof gameAccountAudit.$inferInsert)[] = [];
  const changedBy = by.userId ?? null;
  const source = by.source ?? "manual";

  for (const [game, username] of next) {
    const old = prev.get(game);
    if (old === undefined) {
      rows.push({
        player_id: playerId,
        game_name: game,
        action: "added",
        old_game_username: null,
        new_game_username: username,
        changed_by_user_id: changedBy,
        source,
      });
    } else if (old !== username) {
      rows.push({
        player_id: playerId,
        game_name: game,
        action: "updated",
        old_game_username: old,
        new_game_username: username,
        changed_by_user_id: changedBy,
        source,
      });
    }
  }

  for (const [game, username] of prev) {
    if (!next.has(game)) {
      rows.push({
        player_id: playerId,
        game_name: game,
        action: "removed",
        old_game_username: username,
        new_game_username: null,
        changed_by_user_id: changedBy,
        source,
      });
    }
  }

  if (rows.length) await executor.insert(gameAccountAudit).values(rows);
}

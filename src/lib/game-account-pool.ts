import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { gameAccountPool, players } from "@/db/schema";
import { recordGameAccountChanges } from "./game-account-audit";

export class PoolError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AssignedAccount = {
  game_name: string;
  game_username: string;
  game_password: string | null;
  pool_id: number;
};

/**
 * Hand a player the next free account for a game.
 *
 * Everything happens in one transaction with the candidate row locked and
 * skipped if another request already holds it, so two agents assigning at the
 * same moment can never be given the same provider account — the failure that
 * would have two players sharing one game id and one balance.
 *
 * Company-reserved accounts are preferred over unreserved ones, so a batch set
 * aside for a company is used up before the shared stock.
 *
 * Returns null if the player already has an account for that game — assigning a
 * second one would silently orphan their existing balance.
 */
export async function assignAccountFromPool(
  playerId: number,
  gameName: string,
  by: { userId?: number | null; source?: "bot" | "manual" } = {},
): Promise<AssignedAccount | null> {
  return db.transaction(async (txn) => {
    const [player] = await txn
      .select()
      .from(players)
      .where(eq(players.player_id, playerId));
    if (!player) throw new PoolError(404, "Player not found");

    const existing = player.game_accounts ?? [];
    if (existing.some((g) => g.game_name === gameName)) return null;

    const [candidate] = await txn
      .select()
      .from(gameAccountPool)
      .where(
        and(
          eq(gameAccountPool.game_name, gameName),
          eq(gameAccountPool.status, "available"),
          // Either reserved for this player's company, or unreserved.
          or(
            eq(gameAccountPool.company_entity_id, player.company_entity_id),
            isNull(gameAccountPool.company_entity_id),
          ),
        ),
      )
      // Company-reserved stock first (nulls last), then oldest first.
      .orderBy(
        sql`${gameAccountPool.company_entity_id} nulls last`,
        asc(gameAccountPool.pool_id),
      )
      .limit(1)
      .for("update", { skipLocked: true });

    if (!candidate) {
      throw new PoolError(
        409,
        `No ${gameName} accounts left in the pool — the bot needs to create more`,
      );
    }

    const nowIso = new Date().toISOString();
    await txn
      .update(gameAccountPool)
      .set({
        status: "assigned",
        assigned_player_id: playerId,
        assigned_at: nowIso,
      })
      .where(eq(gameAccountPool.pool_id, candidate.pool_id));

    const nextAccounts = [
      ...existing,
      { game_name: gameName, game_username: candidate.game_username },
    ];
    await txn
      .update(players)
      .set({ game_accounts: nextAccounts })
      .where(eq(players.player_id, playerId));

    await recordGameAccountChanges(playerId, existing, nextAccounts, by, txn);

    return {
      game_name: gameName,
      game_username: candidate.game_username,
      game_password: candidate.game_password,
      pool_id: candidate.pool_id,
    };
  });
}

/** How many unassigned accounts are left, per game. */
export async function poolStock(): Promise<
  Array<{ game_name: string; available: number }>
> {
  const rows = await db
    .select({
      game_name: gameAccountPool.game_name,
      available: sql<number>`count(*)::int`,
    })
    .from(gameAccountPool)
    .where(eq(gameAccountPool.status, "available"))
    .groupBy(gameAccountPool.game_name)
    .orderBy(asc(gameAccountPool.game_name));
  return rows;
}

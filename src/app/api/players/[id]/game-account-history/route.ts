import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { gameAccountAudit, players } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * GET /api/players/:id/game-account-history — who changed which game account,
 * newest first. Fetched on demand rather than bundled into /api/state: it's
 * only ever read when someone opens a player's profile.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const playerId = Number(id);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      return jsonError("Invalid player id");
    }

    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.player_id, playerId));
    if (!player) return jsonError("Player not found", 404);
    if (
      user.companyIds !== null &&
      !user.companyIds.includes(player.company_entity_id)
    ) {
      throw new AuthError(403, "Player is outside your company scope");
    }

    const history = await db
      .select()
      .from(gameAccountAudit)
      .where(eq(gameAccountAudit.player_id, playerId))
      .orderBy(desc(gameAccountAudit.created_at))
      .limit(100);

    return Response.json({ history });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

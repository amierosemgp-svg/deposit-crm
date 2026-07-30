import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { assignAccountFromPool, poolStock, PoolError } from "@/lib/game-account-pool";

const bodySchema = z.object({ game_name: z.string().min(1) });

/**
 * POST /api/players/:id/auto-assign-game — give the player the next free
 * account for a game, out of the pool the bot pre-registered.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const playerId = Number(id);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      return jsonError("Invalid player id");
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Provide game_name");

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

    const assigned = await assignAccountFromPool(
      playerId,
      parsed.data.game_name,
      { userId: user.user_id, source: "manual" },
    );

    if (!assigned) {
      return jsonError(
        `Player already has a ${parsed.data.game_name} account`,
        409,
      );
    }

    return Response.json({ assigned, stock: await poolStock() }, { status: 201 });
  } catch (e) {
    if (e instanceof PoolError) {
      return jsonError(e.message, e.status);
    }
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

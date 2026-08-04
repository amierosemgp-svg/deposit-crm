import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { wouldCycle } from "@/lib/referral";

const bodySchema = z.object({
  // The referrer. null detaches this player from their upline.
  upline_player_id: z.number().int().positive().nullable(),
});

/**
 * PUT /api/players/:id/upline — set or clear who referred this player.
 *
 * :id is the **downline**. Both players must be inside the caller's company
 * scope, so an agent can't wire a payout to a player they can't see.
 */
export async function PUT(
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
    if (!parsed.success) return jsonError("Provide upline_player_id (or null)");
    const uplineId = parsed.data.upline_player_id;

    const inScope = (companyId: number) =>
      user.companyIds === null || user.companyIds.includes(companyId);

    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.player_id, playerId));
    if (!player) return jsonError("Player not found", 404);
    if (!inScope(player.company_entity_id)) {
      throw new AuthError(403, "Player is outside your company scope");
    }

    if (uplineId !== null) {
      if (uplineId === playerId) {
        return jsonError("A player can't be their own upline", 422);
      }
      const [upline] = await db
        .select()
        .from(players)
        .where(eq(players.player_id, uplineId));
      if (!upline) return jsonError("Upline player not found", 404);
      if (!inScope(upline.company_entity_id)) {
        throw new AuthError(403, "Upline is outside your company scope");
      }
      // A → B → A would make the referral tree unwalkable and could pay a
      // bonus in a loop.
      if (await wouldCycle(playerId, uplineId)) {
        return jsonError(
          "That would create a referral loop — the upline is already below this player",
          422,
        );
      }
    }

    const nowIso = new Date().toISOString();
    const [updated] = await db
      .update(players)
      .set({
        upline_player_id: uplineId,
        upline_assigned_at: uplineId === null ? null : nowIso,
      })
      .where(eq(players.player_id, playerId))
      .returning();

    await db.insert(transactions).values({
      player_id: playerId,
      entity_id: player.company_entity_id,
      type: "player_import",
      amount: 0,
      user_id: user.user_id,
      details: {
        action: uplineId === null ? "upline_cleared" : "upline_assigned",
        upline_player_id: uplineId,
        previous_upline_player_id: player.upline_player_id ?? null,
      },
    });

    return Response.json({ player: updated });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

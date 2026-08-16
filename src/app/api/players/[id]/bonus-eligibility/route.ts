import { eq } from "drizzle-orm";
import { db } from "@/db";
import { players } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { evaluatePlansForPlayer } from "@/lib/bonus";

/**
 * GET /api/players/:id/bonus-eligibility?amount=100&deposit_id=42
 *
 * Every bonus this player could be offered, each with a yes/no and — when it's
 * a no — the sentence explaining why. The deposits screen calls this to build
 * its dropdown, so CS sees the answer before picking rather than after the API
 * rejects them.
 *
 * `deposit_id` is the row being bonused; passing it keeps a deposit from
 * disqualifying itself (its own claim and its own place in the player's history
 * are excluded from the lookback).
 */
export async function GET(
  request: Request,
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

    const url = new URL(request.url);
    const amount = Number(url.searchParams.get("amount") ?? 0);
    const depositIdParam = Number(url.searchParams.get("deposit_id") ?? 0);

    const evaluated = await evaluatePlansForPlayer({
      playerId,
      companyEntityId: player.company_entity_id,
      depositAmount: Number.isFinite(amount) && amount > 0 ? amount : 0,
      excludeDepositId: depositIdParam > 0 ? depositIdParam : undefined,
    });

    return Response.json({
      options: evaluated.map(({ plan, verdict }) => ({
        plan_id: plan.plan_id,
        name: plan.name,
        type: plan.type,
        period: plan.period,
        percentage: plan.percentage,
        min_deposit: plan.min_deposit,
        min_loss: plan.min_loss,
        eligible: verdict.eligible,
        reason: verdict.reason,
        bonus_amount: verdict.bonus_amount,
        basis_amount: verdict.basis_amount,
        net_loss: verdict.net_loss,
      })),
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

import { aliasedTable, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { players, referralBonuses } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const downline = aliasedTable(players, "downline");

/**
 * GET /api/players/:id/referral-bonuses — bonuses this player has earned from
 * their downlines' first deposits, newest first. Pending ones are what CS hands
 * out from the Recommend Bonus tab.
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

    const rows = await db
      .select({
        bonus_id: referralBonuses.bonus_id,
        downline_player_id: referralBonuses.downline_player_id,
        downline_username: downline.username,
        downline_full_name: downline.full_name,
        deposit_id: referralBonuses.deposit_id,
        deposit_amount: referralBonuses.deposit_amount,
        bonus_percentage: referralBonuses.bonus_percentage,
        bonus_amount: referralBonuses.bonus_amount,
        status: referralBonuses.status,
        game_name: referralBonuses.game_name,
        skip_bot: referralBonuses.skip_bot,
        game_transfer_id: referralBonuses.game_transfer_id,
        assigned_by_user_id: referralBonuses.assigned_by_user_id,
        assigned_at: referralBonuses.assigned_at,
        note: referralBonuses.note,
        created_at: referralBonuses.created_at,
      })
      .from(referralBonuses)
      .leftJoin(
        downline,
        eq(referralBonuses.downline_player_id, downline.player_id),
      )
      .where(eq(referralBonuses.upline_player_id, playerId))
      .orderBy(desc(referralBonuses.bonus_id));

    const pendingTotal = rows
      .filter((r) => r.status === "pending")
      .reduce((sum, r) => sum + r.bonus_amount, 0);

    return Response.json({
      bonuses: rows,
      pending_total: +pendingTotal.toFixed(2),
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

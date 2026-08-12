import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  gameCredits,
  gameTransfers,
  players,
  referralBonuses,
  transactions,
} from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const bodySchema = z.object({
  game_name: z.string().min(1),
  // true = CS already moved the credit in the back-office themselves.
  // false = queue it for the agent.
  skip_bot: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

/**
 * POST /api/referral-bonuses/:id/assign — hand a pending referral bonus to the
 * upline as game credit.
 *
 * Two routes to the same end, mirroring how deposits work:
 *   - skip_bot: CS did it in the provider back-office, so the credit is booked
 *     here and now.
 *   - otherwise: a game transfer is queued for the agent, and the credit lands
 *     when the agent reports the move completed. Nothing is credited yet.
 *
 * The whole thing runs in one transaction with the bonus row locked, so two
 * agents clicking Assign at the same moment can't pay the bonus twice.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const bonusId = Number(id);
    if (!Number.isInteger(bonusId) || bonusId <= 0) {
      return jsonError("Invalid bonus id");
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Provide game_name");
    const { game_name, skip_bot = false, note } = parsed.data;

    const result = await db.transaction(async (txn) => {
      const [bonus] = await txn
        .select()
        .from(referralBonuses)
        .where(eq(referralBonuses.bonus_id, bonusId))
        .for("update");
      if (!bonus) throw new AuthError(404, "Bonus not found");
      if (bonus.status !== "pending") {
        throw new AuthError(409, `Bonus is already ${bonus.status}`);
      }

      const [upline] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, bonus.upline_player_id));
      if (!upline) throw new AuthError(404, "Upline player not found");
      if (
        user.companyIds !== null &&
        !user.companyIds.includes(upline.company_entity_id)
      ) {
        throw new AuthError(403, "Player is outside your company scope");
      }

      // Credit has to land in an account the player actually holds, or it goes
      // nowhere the player can reach.
      const hasGame = (upline.game_accounts ?? []).some(
        (g) => g.game_name === game_name,
      );
      if (!hasGame) {
        throw new AuthError(
          422,
          `${upline.username} has no ${game_name} account linked`,
        );
      }

      const nowIso = new Date().toISOString();
      let gameTransferId: number | null = null;

      if (skip_bot) {
        // CS moved it by hand — book the credit now.
        await txn
          .insert(gameCredits)
          .values({
            player_id: upline.player_id,
            game_name,
            current_balance: bonus.bonus_amount,
            last_updated_at: nowIso,
          })
          .onConflictDoUpdate({
            target: [gameCredits.player_id, gameCredits.game_name],
            set: {
              current_balance: sql`${gameCredits.current_balance} + ${bonus.bonus_amount}`,
              last_updated_at: nowIso,
            },
          });
      } else {
        // Queue it for the agent. Same lifecycle as a CS-requested transfer, so
        // the stall sweep and the Game Credit Transfer page cover it for free.
        // from_game === to_game marks it as a credit-in rather than a move
        // between two of the player's games.
        const [transfer] = await txn
          .insert(gameTransfers)
          .values({
            player_id: upline.player_id,
            from_game: game_name,
            to_game: game_name,
            transfer_amount: bonus.bonus_amount,
            from_game_balance_before: 0,
            status: "pending",
            started_at: nowIso,
            handled_by_user_id: user.user_id,
            note: `Referral bonus #${bonus.bonus_id} — credit in ${game_name}`,
          })
          .returning();
        gameTransferId = transfer.transfer_id;
      }

      const [updated] = await txn
        .update(referralBonuses)
        .set({
          status: "assigned",
          game_name,
          skip_bot,
          game_transfer_id: gameTransferId,
          assigned_by_user_id: user.user_id,
          assigned_at: nowIso,
          note: note ?? null,
        })
        .where(eq(referralBonuses.bonus_id, bonusId))
        .returning();

      await txn.insert(transactions).values({
        player_id: upline.player_id,
        entity_id: upline.company_entity_id,
        type: "game_topup",
        amount: bonus.bonus_amount,
        game_name,
        reference_id: bonus.bonus_id,
        user_id: user.user_id,
        details: {
          action: "referral_bonus_assigned",
          source: skip_bot ? "manual" : "bot",
          downline_player_id: bonus.downline_player_id,
          deposit_amount: bonus.deposit_amount,
          bonus_percentage: bonus.bonus_percentage,
          game_transfer_id: gameTransferId,
        },
      });

      return updated;
    });

    return Response.json({ bonus: result });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

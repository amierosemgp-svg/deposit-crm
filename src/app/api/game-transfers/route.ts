import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameCredits, gameTransfers, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const createSchema = z.object({
  player_id: z.number().int().positive(),
  from_game: z.string().min(1),
  to_game: z.string().min(1),
  amount: z.number().positive(),
});

/**
 * POST /api/game-transfers — CS requests a credit move between two of a
 * player's games. The credits are NOT moved here: the transfer is queued as
 * "pending" (Initializing), the bot claims it into "processing", performs the
 * real game-provider back-office transfer, then marks it completed (credits
 * move then) or failed (nothing to reverse).
 * The balance is validated up front so obviously-invalid requests are rejected
 * early; the bot re-validates atomically at completion.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;
    if (body.from_game === body.to_game) {
      return jsonError("From and to game must differ");
    }

    const result = await db.transaction(async (txn) => {
      const [player] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, body.player_id));
      if (!player) throw new AuthError(404, "Player not found");
      if (
        user.companyIds !== null &&
        !user.companyIds.includes(player.company_entity_id)
      ) {
        throw new AuthError(403, "Player is outside your company scope");
      }

      const [fromCredit] = await txn
        .select()
        .from(gameCredits)
        .where(
          and(
            eq(gameCredits.player_id, body.player_id),
            eq(gameCredits.game_name, body.from_game),
          ),
        );
      const fromBalance = fromCredit?.current_balance ?? 0;
      if (fromBalance < body.amount) {
        throw new AuthError(
          422,
          `Insufficient ${body.from_game} balance (${fromBalance.toFixed(2)})`,
        );
      }

      const [transfer] = await txn
        .insert(gameTransfers)
        .values({
          player_id: body.player_id,
          from_game: body.from_game,
          to_game: body.to_game,
          transfer_amount: body.amount,
          from_game_balance_before: fromBalance,
          // "pending" = Initializing: queued, waiting for the bot to claim it.
          // The bot moves it to "processing" when it actually starts the
          // provider-side move, so a transfer nobody picked up is
          // distinguishable from one that's genuinely in progress.
          status: "pending",
          started_at: new Date().toISOString(),
          handled_by_user_id: user.user_id,
        })
        .returning();

      await txn.insert(transactions).values({
        player_id: body.player_id,
        entity_id: player.company_entity_id,
        type: "game_transfer",
        amount: body.amount,
        game_name: `${body.from_game} → ${body.to_game}`,
        reference_id: transfer.transfer_id,
        user_id: user.user_id,
        details: { action: "initiated", from: body.from_game, to: body.to_game },
      });

      return transfer;
    });

    return Response.json({ transfer: result }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

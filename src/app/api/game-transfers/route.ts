import { and, eq, sql } from "drizzle-orm";
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

/** POST /api/game-transfers — move a player's credits between games, atomically. */
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
        )
        .for("update");
      const fromBalance = fromCredit?.current_balance ?? 0;
      if (fromBalance < body.amount) {
        throw new AuthError(
          422,
          `Insufficient ${body.from_game} balance (${fromBalance.toFixed(2)})`,
        );
      }

      const nowIso = new Date().toISOString();
      await txn
        .update(gameCredits)
        .set({
          current_balance: +(fromBalance - body.amount).toFixed(2),
          last_updated_at: nowIso,
        })
        .where(
          and(
            eq(gameCredits.player_id, body.player_id),
            eq(gameCredits.game_name, body.from_game),
          ),
        );
      await txn
        .insert(gameCredits)
        .values({
          player_id: body.player_id,
          game_name: body.to_game,
          current_balance: body.amount,
          last_updated_at: nowIso,
        })
        .onConflictDoUpdate({
          target: [gameCredits.player_id, gameCredits.game_name],
          set: {
            current_balance: sql`${gameCredits.current_balance} + ${body.amount}`,
            last_updated_at: nowIso,
          },
        });

      const [transfer] = await txn
        .insert(gameTransfers)
        .values({
          player_id: body.player_id,
          from_game: body.from_game,
          to_game: body.to_game,
          transfer_amount: body.amount,
          from_game_balance_before: fromBalance,
          status: "completed",
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
        details: { from: body.from_game, to: body.to_game },
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

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players, transactions, withdrawals } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const createSchema = z.object({
  player_id: z.number().int().positive(),
  requested_amount: z.number().positive(),
  game_name: z.string().min(1),
  bank_name: z.string().optional(),
  bank_account_number: z.string().optional(),
  // Fully manual: the bot never auto-pulls/pays this — CS handles it.
  skip_bot: z.boolean().optional(),
});

/** POST /api/withdrawals — CS logs a withdrawal request received on Telegram/WeChat. */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.player_id, body.player_id));
    if (!player) return jsonError("Player not found", 404);
    if (
      user.companyIds !== null &&
      !user.companyIds.includes(player.company_entity_id)
    ) {
      throw new AuthError(403, "Player is outside your company scope");
    }

    const [created] = await db
      .insert(withdrawals)
      .values({
        player_id: body.player_id,
        requested_amount: body.requested_amount,
        game_name: body.game_name,
        bank_name: body.bank_name,
        bank_account_number: body.bank_account_number,
        source: "manual",
        skip_bot: body.skip_bot ?? false,
        handled_by_user_id: user.user_id,
      })
      .returning();

    await db.insert(transactions).values({
      player_id: body.player_id,
      entity_id: player.company_entity_id,
      type: "withdrawal",
      amount: body.requested_amount,
      game_name: body.game_name,
      reference_id: created.withdrawal_id,
      user_id: user.user_id,
      details: { action: "requested", source: "manual" },
    });

    return Response.json({ withdrawal: created }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

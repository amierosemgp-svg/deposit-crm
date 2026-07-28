import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const createSchema = z.object({
  player_id: z.number().int().positive(),
  amount: z.number().positive(),
  bank_name: z.string().min(1),
  // "pending_match" = intent, waiting for the bot to confirm the bank credit.
  // "pending" = CS already sighted the receipt, straight to approval queue.
  status: z.enum(["pending_match", "pending"]).default("pending_match"),
  selected_game: z.string().optional(),
  bonus_percentage: z.number().min(0).max(200).optional(),
  receipt_url: z.string().url().optional(),
  notes: z.string().optional(),
  // Fully manual: no bot bank-match or top-up — CS approves → completes it.
  skip_bot: z.boolean().optional(),
});

/**
 * POST /api/deposits — CS creates a deposit intent when the player says
 * "I've transferred RM50". The bot later confirms it via PATCH /api/bot/
 * transactions/:id/match (flow B).
 */
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

    const bonusPct = body.bonus_percentage ?? 0;
    const bonusAmt = +((body.amount * bonusPct) / 100).toFixed(2);
    // A skip-bot deposit has no bot bank-match step, so it always starts at
    // "pending" (ready for manual approval), never "pending_match".
    const status = body.skip_bot ? "pending" : body.status;
    const nowIso = new Date().toISOString();
    const [created] = await db
      .insert(deposits)
      .values({
        transaction_ref: `CRM-${Date.now()}`,
        deposit_date: nowIso,
        player_id: player.player_id,
        player_username: player.username,
        company_entity_id: player.company_entity_id,
        deposit_amount: body.amount,
        bank_name: body.bank_name,
        selected_game: body.selected_game,
        bonus_percentage: bonusPct,
        bonus_amount: bonusAmt,
        total_amount: +(body.amount + bonusAmt).toFixed(2),
        status,
        source: "manual",
        skip_bot: body.skip_bot ?? false,
        receipt_url: body.receipt_url,
        handled_by_user_id: user.user_id,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .returning();

    await db.insert(transactions).values({
      player_id: player.player_id,
      entity_id: player.company_entity_id,
      type: "deposit",
      amount: body.amount,
      reference_id: created.deposit_id,
      user_id: user.user_id,
      details: {
        source: "manual",
        action: "intent_created",
        status,
        skip_bot: body.skip_bot ?? false,
      },
    });

    return Response.json({ deposit: created }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

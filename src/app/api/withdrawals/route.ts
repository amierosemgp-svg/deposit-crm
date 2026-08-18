import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameCredits, players, transactions, withdrawals } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const createSchema = z.object({
  player_id: z.number().int().positive(),
  // Optional when withdraw_all is set — the figure isn't known until the
  // agent opens the wallet.
  requested_amount: z.number().positive().optional(),
  withdraw_all: z.boolean().optional(),
  game_name: z.string().min(1),
  bank_name: z.string().optional(),
  bank_account_number: z.string().optional(),
  // Fully manual: the agent never auto-pulls/pays this — CS handles it.
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

    // A player can't withdraw more game credit than they hold. The UI already
    // caps the field, but this is the only check the bot and any direct API
    // The balance is read for context only. game_credits is a cache the agent
    // refreshes, so it lags the real provider wallet — a player showing RM 17
    // here may hold RM 100 there. Refusing on it would block CS from acting on
    // what the player can actually see, so the request stands and the pull step
    // deals with whatever is really in the wallet.
    const [credit] = await db
      .select()
      .from(gameCredits)
      .where(
        and(
          eq(gameCredits.player_id, body.player_id),
          eq(gameCredits.game_name, body.game_name),
        ),
      );
    const balance = credit?.current_balance ?? 0;

    const withdrawAll = body.withdraw_all ?? false;
    if (!withdrawAll && !body.requested_amount) {
      return jsonError("Enter an amount, or tick withdraw all");
    }
    // 0 is the placeholder for "as much as is there"; the pull writes the truth.
    const requested = withdrawAll ? 0 : body.requested_amount!;

    const [created] = await db
      .insert(withdrawals)
      .values({
        player_id: body.player_id,
        requested_amount: requested,
        withdraw_all: withdrawAll,
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
      amount: requested,
      game_name: body.game_name,
      reference_id: created.withdrawal_id,
      user_id: user.user_id,
      details: {
        action: "requested",
        source: "manual",
        withdraw_all: withdrawAll,
        // What the CRM believed the wallet held at the time. Kept because it
        // is a cache — when the pulled figure differs, this says by how much.
        known_balance: balance,
      },
    });

    return Response.json({ withdrawal: created }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

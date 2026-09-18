import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameCredits, players, transactions, withdrawals } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { checkWithdrawalMinimum } from "@/lib/withdrawal-limits";
import { bookManualPull } from "@/lib/withdrawal-pull";

const createSchema = z.object({
  player_id: z.number().int().positive(),
  // Optional when withdraw_all is set — the figure isn't known until the
  // agent opens the wallet.
  requested_amount: z.number().positive().optional(),
  withdraw_all: z.boolean().optional(),
  game_name: z.string().min(1),
  // Which login under game_name to pull from. Omit for the player's first.
  game_username: z.string().max(120).optional(),
  bank_name: z.string().optional(),
  bank_account_number: z.string().optional(),
  // Which of OUR accounts pays it out. The bank_* fields above are the
  // player's; without this there is nothing to deduct when it is marked paid.
  paid_from_account_id: z.number().int().positive().optional(),
  // Fully manual: the agent never auto-pulls/pays this — CS handles it.
  skip_bot: z.boolean().optional(),
  // Claim it under the caller's name as it's created (the sheet's "Assign to
  // me" cell) — the same ownership marker POST /api/assignments sets.
  assign_to_me: z.boolean().optional(),
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

    // House minimum, measured on the player's own money — bonus credit in the
    // wallet does not count toward it. Inert until an admin sets one.
    //
    // Note this is the one balance-based refusal in this route: the amount
    // check above it deliberately does not block, because game_credits lags the
    // provider. The minimum is a house policy rather than a solvency check, so
    // it is applied to the figure the CRM holds and CS is told what that figure
    // is, rather than being refused with no explanation.
    const minCheck = await checkWithdrawalMinimum(db, {
      playerId: body.player_id,
      gameName: body.game_name,
      balance,
    });
    if (!minCheck.ok) return jsonError(minCheck.message, 422);
    // 0 is the placeholder for "as much as is there"; the pull writes the truth.
    const requested = withdrawAll ? 0 : body.requested_amount!;

    const skipBot = body.skip_bot ?? true;
    const nowIso = new Date().toISOString();

    /**
     * A manual withdrawal is already pulled by the time it is typed.
     *
     * CS opens the kiosk, takes the player's credit out, types the row, then
     * pays the bank — so "requested" was a state the row was never really in.
     * It is created at credits_pulled with the credit booked back into the
     * company's float, leaving one honest step left: marking it paid, which is
     * the part that has not happened yet.
     *
     * Two rows can't take that shortcut: an agent row (the agent does the
     * pulling and reports the figure back), and a withdraw-all, where nobody
     * yet knows what the wallet held — those wait at "requested" as before.
     */
    const autoPull = skipBot && !withdrawAll && requested > 0;

    const { created, pulled } = await db.transaction(async (txn) => {
      const [row] = await txn
        .insert(withdrawals)
        .values({
          player_id: body.player_id,
          requested_amount: requested,
          withdraw_all: withdrawAll,
          game_name: body.game_name,
          game_username: body.game_username,
          bank_name: body.bank_name,
          bank_account_number: body.bank_account_number,
          paid_from_account_id: body.paid_from_account_id ?? null,
          source: "manual",
          skip_bot: skipBot,
          handled_by_user_id: user.user_id,
          ...(body.assign_to_me
            ? { assigned_to_user_id: user.user_id, assigned_at: nowIso }
            : {}),
        })
        .returning();

      await txn.insert(transactions).values({
        player_id: body.player_id,
        entity_id: player.company_entity_id,
        type: "withdrawal",
        amount: requested,
        game_name: body.game_name,
        reference_id: row.withdrawal_id,
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

      if (!autoPull) return { created: row, pulled: false };
      const done = await bookManualPull(txn, {
        row,
        player,
        pulled: requested,
        userId: user.user_id,
        nowIso,
      });
      return { created: done, pulled: true };
    });

    return Response.json(
      {
        withdrawal: created,
        // Say when the shortcut didn't apply, so "why is this one still
        // Requested?" is answered where it is asked.
        ...(!pulled && skipBot && withdrawAll
          ? { warning: "Saved as Requested — pull it once you know what the wallet held." }
          : {}),
      },
      { status: 201 },
    );
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

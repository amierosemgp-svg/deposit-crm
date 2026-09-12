import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameCredits, gameTransfers, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { canonicalise } from "@/lib/game-name";
import { creditWhere, resolveGameLogin } from "@/lib/game-credits";

const createSchema = z.object({
  player_id: z.number().int().positive(),
  from_game: z.string().min(1),
  to_game: z.string().min(1),
  // Optional when transfer_all is set — the figure isn't known until the agent
  // reads the source wallet.
  amount: z.number().positive().optional(),
  transfer_all: z.boolean().optional(),
  // Which specific logins the move is between. Omit for the player's first
  // account on each game.
  from_game_username: z.string().max(120).optional(),
  // Claim it under the caller's name as it's created (the sheet's "Assign to
  // me" cell) — the same ownership marker POST /api/assignments sets.
  assign_to_me: z.boolean().optional(),
  to_game_username: z.string().max(120).optional(),
});

/**
 * POST /api/game-transfers — CS requests a credit move between two of a
 * player's games. The credits are NOT moved here: the transfer is queued as
 * "pending" (Initializing), the agent claims it into "processing", performs the
 * real game-provider back-office transfer, then marks it completed (credits
 * move then) or failed (nothing to reverse).
 * The balance is validated up front so obviously-invalid requests are rejected
 * early; the agent re-validates atomically at completion.
 *
 * With `transfer_all` the amount is left at 0 and no up-front balance check is
 * made: the whole point of the flag is that our cached figure is not the one to
 * act on. The agent empties the source wallet and reports what was really
 * there.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;
    const transferAll = body.transfer_all ?? false;
    if (!transferAll && !body.amount) {
      return jsonError("Provide an amount, or set transfer_all");
    }
    // Canonical spelling before anything is stored or compared: game_credits
    // carries a case-insensitive unique index, so "918kiss" and "918Kiss" must
    // resolve to one name here or the credit move fails at completion.
    const fromGame = await canonicalise(body.from_game);
    const toGame = await canonicalise(body.to_game);
    if (fromGame.toLowerCase() === toGame.toLowerCase()) {
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

      const fromLogin = resolveGameLogin(player.game_accounts, fromGame, body.from_game_username);
      const toLogin = resolveGameLogin(player.game_accounts, toGame, body.to_game_username);
      const [fromCredit] = await txn
        .select()
        .from(gameCredits)
        .where(creditWhere(body.player_id, fromGame, fromLogin));
      const fromBalance = fromCredit?.current_balance ?? 0;
      // Skipped for transfer_all on purpose: the cached balance is exactly the
      // number the flag exists to stop trusting. A wallet the agent finds empty
      // comes back as a failed transfer with a reason, which is the honest
      // outcome — better than refusing here on a figure that may be stale.
      const amount = transferAll ? 0 : body.amount!;
      if (!transferAll && fromBalance < amount) {
        throw new AuthError(
          422,
          `Insufficient ${fromGame} balance (${fromBalance.toFixed(2)})`,
        );
      }

      const [transfer] = await txn
        .insert(gameTransfers)
        .values({
          player_id: body.player_id,
          from_game: fromGame,
          to_game: toGame,
          from_game_username: fromLogin,
          to_game_username: toLogin,
          // 0 under transfer_all — a placeholder the agent replaces with the
          // figure it actually moved.
          transfer_amount: amount,
          transfer_all: transferAll,
          from_game_balance_before: fromBalance,
          // "pending" = Initializing: queued, waiting for the agent to claim it.
          // The agent moves it to "processing" when it actually starts the
          // provider-side move, so a transfer nobody picked up is
          // distinguishable from one that's genuinely in progress.
          status: "pending",
          started_at: new Date().toISOString(),
          handled_by_user_id: user.user_id,
          ...(body.assign_to_me
            ? { assigned_to_user_id: user.user_id, assigned_at: new Date().toISOString() }
            : {}),
        })
        .returning();

      await txn.insert(transactions).values({
        player_id: body.player_id,
        entity_id: player.company_entity_id,
        type: "game_transfer",
        amount,
        game_name: `${fromGame} → ${toGame}`,
        reference_id: transfer.transfer_id,
        user_id: user.user_id,
        details: {
          action: "initiated",
          from: fromGame,
          to: toGame,
          transfer_all: transferAll,
          // What we believed the source held when CS asked — context for the
          // figure the agent later reports, not an instruction.
          cached_from_balance: fromBalance,
        },
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

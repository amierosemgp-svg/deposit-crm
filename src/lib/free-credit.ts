import { db } from "@/db";
import { gameTransfers, players, transactions } from "@/db/schema";
import { AuthError, type AuthedUser } from "@/lib/auth";
import { creditRecommendBonus, InsufficientBoCreditError } from "@/lib/referral";
import { resolveGameLogin } from "@/lib/game-credits";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PlayerRow = typeof players.$inferSelect;

/**
 * Inject game credit with no deposit behind it — a rebate, a goodwill credit,
 * a promo. The one path the Free Credit sheet and the Rebates page both ride.
 *
 * Two rails, same as a referral-bonus payout:
 *   - skipBot: CS credited the game in the provider back-office themselves —
 *     the player's balance and the company BO pool are booked here and now.
 *   - otherwise: a credit-in game transfer (from_game === to_game) is queued;
 *     the balance moves when the agent reports it completed.
 *
 * Either way one `game_topup` audit row with details.action = "free_credit" is
 * written — that row IS the Free Credit ledger, so a queued agent credit shows
 * the moment it's entered. Throws AuthError with the right status when the
 * player has no such game or the BO pool can't cover a hand credit.
 */
export async function issueFreeCredit(
  txn: Tx,
  input: {
    user: AuthedUser;
    player: PlayerRow;
    gameName: string;
    /** Which login under the game. Omit for the player's first account. */
    gameUsername?: string | null;
    amount: number;
    reason?: string | null;
    skipBot: boolean;
    /** Extra ledger details — e.g. which rebate payout this credit settles. */
    details?: Record<string, unknown>;
  },
): Promise<{ transactionId: number; gameTransferId: number | null; gameUsername: string }> {
  const { user, player, gameName, amount, reason, skipBot } = input;

  // Credit has to land in an account the player actually holds, or it goes
  // nowhere the player can reach.
  const hasGame = (player.game_accounts ?? []).some(
    (g) => g.game_name.toLowerCase() === gameName.toLowerCase(),
  );
  if (!hasGame) {
    throw new AuthError(422, `${player.username} has no ${gameName} account linked`);
  }

  const login = resolveGameLogin(player.game_accounts, gameName, input.gameUsername);
  const nowIso = new Date().toISOString();
  let gameTransferId: number | null = null;

  if (skipBot) {
    // Same booking as a hand-credited referral bonus: player balance up,
    // company BO pool down. Fails cleanly when the pool can't cover it.
    try {
      await creditRecommendBonus(txn, {
        playerId: player.player_id,
        companyEntityId: player.company_entity_id,
        gameName,
        gameUsername: login,
        amount,
        nowIso,
      });
    } catch (e) {
      if (e instanceof InsufficientBoCreditError) throw new AuthError(422, e.message);
      throw e;
    }
  } else {
    // Queue it for the agent. from_game === to_game marks a credit-in — the
    // same shape the referral payout uses, so the agent, the stall sweep and
    // the Game Credit Transfer page all handle it unchanged.
    const [transfer] = await txn
      .insert(gameTransfers)
      .values({
        player_id: player.player_id,
        from_game: gameName,
        to_game: gameName,
        from_game_username: login,
        to_game_username: login,
        transfer_amount: amount,
        from_game_balance_before: 0,
        status: "pending",
        started_at: nowIso,
        handled_by_user_id: user.user_id,
        note: `Free credit${reason ? ` — ${reason}` : ""}`,
      })
      .returning();
    gameTransferId = transfer.transfer_id;
  }

  const [audit] = await txn
    .insert(transactions)
    .values({
      player_id: player.player_id,
      entity_id: player.company_entity_id,
      type: "game_topup",
      amount,
      game_name: gameName,
      reference_id: gameTransferId,
      user_id: user.user_id,
      details: {
        action: "free_credit",
        source: skipBot ? "manual" : "bot",
        game_username: login,
        reason: reason ?? null,
        game_transfer_id: gameTransferId,
        ...(input.details ?? {}),
      },
    })
    .returning();

  return { transactionId: audit.transaction_id, gameTransferId, gameUsername: login };
}

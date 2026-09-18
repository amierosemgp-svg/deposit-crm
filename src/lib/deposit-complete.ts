import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { deposits, gameCredits, players, transactions } from "@/db/schema";
import { balanceSyncedSince, canonicalise } from "@/lib/game-name";
import {
  adjustGameCredit,
  CREDIT_CONFLICT_TARGET,
  resolveGameLogin,
} from "@/lib/game-credits";
import { moveBankBalance } from "@/lib/bank-balance";
import { moveKioskCredit } from "@/lib/kiosk-credit";
import { maybeCreateReferralBonus } from "@/lib/referral";

type Txn = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DepositRow = typeof deposits.$inferSelect;

/**
 * Book a manual deposit as done: the player's game balance up, the company's
 * kiosk float down, total_deposits up, the row marked completed.
 *
 * Lifted out of POST /api/deposits/:id/complete so that saving a manual row
 * and completing one later run the same booking. They used to be the same
 * steps written once; the moment the sheet could complete on save, two copies
 * would have meant two ways for the ledger to end up.
 *
 * The caller owns the transaction and must have locked `row` if it wasn't
 * created inside it. Throws InsufficientKioskCreditError when the float can't
 * cover the top-up — the one failure a caller may reasonably want to absorb.
 */
export async function completeManualDeposit(
  txn: Txn,
  input: { row: DepositRow; userId: number; nowIso?: string },
): Promise<DepositRow> {
  const { row, userId } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (!row.player_id || !row.selected_game) {
    throw new Error("completeManualDeposit needs a player and a game");
  }

  /**
   * The bank that took the money goes up by what the player actually paid.
   *
   * Only the deposit, never the total: the bonus is house credit granted at
   * the kiosk, and no ringgit of it passes through a bank. Until this existed
   * a bank balance could only ever fall — withdrawals, expenses and cash-outs
   * all debited it and nothing credited it — so a day of trading left the
   * recorded figure short by everything the desk took in.
   *
   * Skipped when the row never named an account, which is every row imported
   * from a trading sheet: those balances came from the sheet's own dashboard.
   */
  if (row.received_into_account_id !== null) {
    await moveBankBalance(txn, {
      accountId: row.received_into_account_id,
      delta: row.deposit_amount,
    });
  }

  // The float pays for the top-up. Silently skipped when the company keeps no
  // kiosk row for the game — see moveKioskCredit.
  await moveKioskCredit(txn, {
    companyEntityId: row.company_entity_id,
    gameName: row.selected_game,
    delta: -row.total_amount,
  });

  // Same two rules as the agent's completion path: one canonical spelling per
  // game, and never add a delta on top of a balance the agent has already read
  // off the provider.
  const gameName = await canonicalise(row.selected_game, txn);
  const [pl] = await txn
    .select({ game_accounts: players.game_accounts })
    .from(players)
    .where(eq(players.player_id, row.player_id));
  const gameUsername = resolveGameLogin(
    pl?.game_accounts ?? null,
    gameName,
    row.selected_game_username,
  );
  const alreadySynced = await balanceSyncedSince(txn, {
    playerId: row.player_id,
    gameName,
    gameUsername,
    sinceIso: row.approved_at ?? row.updated_at ?? row.created_at,
  });

  if (!alreadySynced) {
    await txn
      .insert(gameCredits)
      .values({
        player_id: row.player_id,
        game_name: gameName,
        game_username: gameUsername,
        current_balance: row.total_amount,
        last_updated_at: nowIso,
      })
      .onConflictDoUpdate({
        target: [...CREDIT_CONFLICT_TARGET],
        set: {
          current_balance: sql`${gameCredits.current_balance} + ${row.total_amount}`,
          last_updated_at: nowIso,
        },
      });
  }

  await txn
    .update(players)
    .set({ total_deposits: sql`${players.total_deposits} + ${row.deposit_amount}` })
    .where(eq(players.player_id, row.player_id));

  const [updated] = await txn
    .update(deposits)
    .set({ status: "completed", handled_by_user_id: userId, updated_at: nowIso })
    .where(eq(deposits.deposit_id, row.deposit_id))
    .returning();

  await txn.insert(transactions).values({
    player_id: row.player_id,
    entity_id: row.company_entity_id,
    type: "game_topup",
    amount: row.total_amount,
    game_name: gameName,
    reference_id: row.deposit_id,
    user_id: userId,
    details: {
      source: "manual",
      game_username: gameUsername,
      action: "manual_complete",
      ...(alreadySynced
        ? {
            balance_credited: false,
            reason: "agent had already synced the provider balance",
            synced_at: alreadySynced.created_at,
            synced_balance: alreadySynced.balance_after,
          }
        : { balance_credited: true }),
    },
  });

  // Inside the same transaction, so a bonus can't survive a rollback.
  await maybeCreateReferralBonus(txn, row.deposit_id);

  return updated;
}

/**
 * Re-book a deposit that was already completed, after CS corrected the row.
 *
 * Every completion moved three things: the player's wallet up, the company's
 * kiosk float down, and total_deposits up. An edit has to unwind exactly those
 * and lay down the new ones — a typed 500 that should have been 50 otherwise
 * leaves RM 450 of credit standing against a row that no longer claims it.
 *
 * Done as one netted set of deltas rather than a reverse followed by a fresh
 * apply: when only the figure changed, the wallet and the float see a single
 * small correction instead of a full refund and re-charge, which is both what
 * really happened and what stops a same-game pair landing on two different
 * back-office accounts.
 *
 * Returns any wallet left below zero. That means the player has already spent
 * credit the correction takes back — the row is right and the cached balance
 * is now behind the provider, which is CS's cue to sync, not a reason to
 * refuse the correction.
 */
export async function rebookCompletedDeposit(
  txn: Txn,
  input: { before: DepositRow; after: DepositRow; userId: number; nowIso?: string },
): Promise<{ negativeWallets: Array<{ game: string; login: string; balance: number }> }> {
  const { before, after, userId } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();

  /**
   * Did the completion actually write the wallet credit?
   *
   * It skips the write when the agent had already read the real balance off
   * the provider (see completeManualDeposit). Reversing a credit that was
   * never written would take the player's money twice, so the ledger row that
   * recorded the decision is the thing asked, not assumed.
   */
  const [completion] = await txn
    .select({ details: transactions.details })
    .from(transactions)
    .where(
      and(
        eq(transactions.reference_id, before.deposit_id),
        eq(transactions.type, "game_topup"),
        sql`${transactions.details}->>'action' = 'manual_complete'`,
      ),
    )
    .orderBy(desc(transactions.transaction_id))
    .limit(1);
  const walletWasCredited =
    (completion?.details as { balance_credited?: boolean } | undefined)?.balance_credited !== false;

  const loginOf = async (row: DepositRow): Promise<string> => {
    if (!row.player_id || !row.selected_game) return "";
    const [pl] = await txn
      .select({ game_accounts: players.game_accounts })
      .from(players)
      .where(eq(players.player_id, row.player_id));
    return resolveGameLogin(
      pl?.game_accounts ?? null,
      await canonicalise(row.selected_game, txn),
      row.selected_game_username,
    );
  };

  // Net every movement first, so an unchanged game nets to the difference.
  const kiosk = new Map<string, { companyEntityId: number; gameName: string; delta: number }>();
  const wallet = new Map<
    string,
    { playerId: number; gameName: string; login: string; delta: number }
  >();
  const totals = new Map<number, number>();
  const banks = new Map<number, number>();

  const addKiosk = (companyEntityId: number | null, gameName: string | null, delta: number) => {
    if (companyEntityId === null || !gameName || delta === 0) return;
    const key = `${companyEntityId}::${gameName.toLowerCase()}`;
    const at = kiosk.get(key) ?? { companyEntityId, gameName, delta: 0 };
    at.delta += delta;
    kiosk.set(key, at);
  };
  const addWallet = (
    playerId: number | null,
    gameName: string | null,
    login: string,
    delta: number,
  ) => {
    if (!walletWasCredited || playerId === null || !gameName || delta === 0) return;
    const key = `${playerId}::${gameName.toLowerCase()}::${login.toLowerCase()}`;
    const at = wallet.get(key) ?? { playerId, gameName, login, delta: 0 };
    at.delta += delta;
    wallet.set(key, at);
  };
  const addBank = (accountId: number | null, delta: number) => {
    if (accountId === null || delta === 0) return;
    banks.set(accountId, (banks.get(accountId) ?? 0) + delta);
  };
  const addTotal = (playerId: number | null, delta: number) => {
    if (playerId === null || delta === 0) return;
    totals.set(playerId, (totals.get(playerId) ?? 0) + delta);
  };

  const beforeGame = before.selected_game ? await canonicalise(before.selected_game, txn) : null;
  const afterGame = after.selected_game ? await canonicalise(after.selected_game, txn) : null;
  const beforeLogin = await loginOf(before);
  const afterLogin = await loginOf(after);

  // Out with the old booking…
  addKiosk(before.company_entity_id, beforeGame, before.total_amount);
  addWallet(before.player_id, beforeGame, beforeLogin, -before.total_amount);
  addTotal(before.player_id, -before.deposit_amount);
  addBank(before.received_into_account_id, -before.deposit_amount);
  // …in with the new.
  addKiosk(after.company_entity_id, afterGame, -after.total_amount);
  addWallet(after.player_id, afterGame, afterLogin, after.total_amount);
  addTotal(after.player_id, after.deposit_amount);
  addBank(after.received_into_account_id, after.deposit_amount);

  for (const k of kiosk.values()) {
    await moveKioskCredit(txn, {
      companyEntityId: k.companyEntityId,
      gameName: k.gameName,
      delta: k.delta,
    });
  }

  const negativeWallets: Array<{ game: string; login: string; balance: number }> = [];
  for (const w of wallet.values()) {
    const balance = await adjustGameCredit(txn, {
      playerId: w.playerId,
      gameName: w.gameName,
      gameUsername: w.login,
      delta: w.delta,
      nowIso,
    });
    if (balance < 0) negativeWallets.push({ game: w.gameName, login: w.login, balance });
  }

  for (const [accountId, delta] of banks) {
    await moveBankBalance(txn, { accountId, delta });
  }

  for (const [playerId, delta] of totals) {
    await txn
      .update(players)
      .set({ total_deposits: sql`${players.total_deposits} + ${delta}` })
      .where(eq(players.player_id, playerId));
  }

  await txn.insert(transactions).values({
    player_id: after.player_id,
    entity_id: after.company_entity_id,
    type: "game_topup",
    amount: +(after.total_amount - before.total_amount).toFixed(2),
    game_name: afterGame,
    reference_id: after.deposit_id,
    user_id: userId,
    details: {
      source: "manual",
      action: "rebooked_after_edit",
      from: {
        amount: before.deposit_amount,
        bonus: before.bonus_amount,
        game: beforeGame,
        game_username: beforeLogin,
        player_id: before.player_id,
      },
      to: {
        amount: after.deposit_amount,
        bonus: after.bonus_amount,
        game: afterGame,
        game_username: afterLogin,
        player_id: after.player_id,
      },
      wallet_credited: walletWasCredited,
      ...(negativeWallets.length ? { wallets_below_zero: negativeWallets } : {}),
    },
  });

  return { negativeWallets };
}

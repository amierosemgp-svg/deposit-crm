import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { gameCredits, players, transactions, withdrawals } from "@/db/schema";
import { adjustGameCredit, creditWhere, resolveGameLogin } from "@/lib/game-credits";
import { moveBankBalance } from "@/lib/bank-balance";
import { moveKioskCredit } from "@/lib/kiosk-credit";

type Txn = Parameters<Parameters<typeof db.transaction>[0]>[0];
type WithdrawalRow = typeof withdrawals.$inferSelect;
type PlayerRow = typeof players.$inferSelect;

/**
 * Book a manual withdrawal as already pulled.
 *
 * CS types the row *after* doing the work: they opened the kiosk, took the
 * player's credit out, and are about to pay the bank. So the figure they typed
 * is the figure that moved, and the credit is already back in the company's
 * float. Making them come back and press Pull afterwards only records later
 * what is already true.
 *
 * Deliberately different from POST /:id/pull, which caps the pull at the
 * cached wallet and refuses when that reads zero. That rule suits a row
 * sitting in the queue waiting to be actioned; applied here it would reject
 * nearly every row on the live data, where 7 of 4,376 players have a cached
 * balance at all — the CRM not knowing a wallet is not evidence the player's
 * wallet is empty.
 *
 * The wallet cache is taken down by at most what it holds, never below zero:
 * subtracting credit the CRM never recorded would print a deficit that says
 * nothing about the player. The float, by contrast, goes up by the whole
 * amount, because that credit really did come back to the kiosk. What each
 * figure did is written to the ledger.
 */
export async function bookManualPull(
  txn: Txn,
  input: {
    row: WithdrawalRow;
    player: PlayerRow;
    pulled: number;
    userId: number;
    nowIso?: string;
    /**
     * What the ledger calls it. "pulled_on_entry" when the row is being typed;
     * a correction that re-lays the pull says so, so History can tell a pull
     * CS did at the kiosk from one the CRM re-booked after an edit.
     */
    action?: string;
  },
): Promise<WithdrawalRow> {
  const { row, player, pulled, userId } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();

  const login = resolveGameLogin(player.game_accounts ?? null, row.game_name, row.game_username);
  const [credit] = await txn
    .select()
    .from(gameCredits)
    .where(creditWhere(row.player_id, row.game_name, login))
    .for("update");
  const balance = credit?.current_balance ?? 0;
  const debited = Math.min(balance, pulled);
  if (credit && debited > 0) {
    await txn
      .update(gameCredits)
      .set({ current_balance: +(balance - debited).toFixed(2), last_updated_at: nowIso })
      .where(creditWhere(row.player_id, row.game_name, login));
  }

  await moveKioskCredit(txn, {
    companyEntityId: player.company_entity_id,
    gameName: row.game_name,
    delta: pulled,
  });

  const [updated] = await txn
    .update(withdrawals)
    .set({
      status: "credits_pulled",
      credit_pulled_amount: pulled,
      handled_by_user_id: userId,
      updated_at: nowIso,
    })
    .where(eq(withdrawals.withdrawal_id, row.withdrawal_id))
    .returning();

  await txn.insert(transactions).values({
    player_id: row.player_id,
    entity_id: player.company_entity_id,
    type: "credit_pull",
    amount: pulled,
    game_name: row.game_name,
    reference_id: row.withdrawal_id,
    user_id: userId,
    details: {
      source: "manual",
      action: input.action ?? "pulled_on_entry",
      game_username: login,
      requested: row.requested_amount,
      balance_before: balance,
      // What the cache could account for. Short of `pulled` means the CRM had
      // no record of the credit CS pulled — expected while balances aren't synced.
      wallet_debited: debited,
    },
  });

  return updated;
}

/**
 * How much of the player's wallet the pull currently has out, read off the
 * pull's latest ledger row.
 *
 * Every pull this module writes says so in `wallet_debited` — the entry pull,
 * a re-book after an edit, and a reversal (which writes 0). A pull made by
 * POST /:id/pull before that route recorded the figure did not, and that one
 * debited the wallet by exactly what it pulled: it capped the pull at the
 * cached balance and took the lot. So a missing key means the row's own
 * amount, not zero — reading it as zero refunded nothing when a withdraw-all
 * row was failed, corrected or deleted. No pull row at all means nothing was
 * taken.
 */
export async function walletDebitedByPull(txn: Txn, withdrawalId: number): Promise<number> {
  const [pull] = await txn
    .select({ amount: transactions.amount, details: transactions.details })
    .from(transactions)
    .where(
      and(
        eq(transactions.reference_id, withdrawalId),
        eq(transactions.type, "credit_pull"),
      ),
    )
    .orderBy(desc(transactions.transaction_id))
    .limit(1);
  if (!pull) return 0;
  const recorded = (pull.details as { wallet_debited?: unknown } | null)?.wallet_debited;
  const debited = recorded === undefined || recorded === null ? pull.amount : Number(recorded);
  return Number.isFinite(debited) && debited > 0 ? debited : 0;
}

/**
 * Re-book a manual withdrawal whose row was corrected after the pull.
 *
 * The pull moved two things: the player's wallet down and the company's float
 * up. A corrected figure — or a different game — has to undo those and lay the
 * new ones down, or the float ends up holding credit the row no longer claims.
 *
 * The float is netted first (a same-game correction is then one small move,
 * and can't land on two back-office accounts), while the wallet is done in
 * order: credit back exactly what the pull took, then debit the new amount
 * against the balance that leaves. The cache is capped at zero in both
 * directions for the reason the pull caps it — a balance the CRM never
 * recorded is not a debt the player owes.
 */
export async function rebookPulledWithdrawal(
  txn: Txn,
  input: { before: WithdrawalRow; after: WithdrawalRow; player: PlayerRow; userId: number },
): Promise<void> {
  const { before, after, player, userId } = input;
  const nowIso = new Date().toISOString();

  const walletDebited = await walletDebitedByPull(txn, before.withdrawal_id);

  const beforeLogin = resolveGameLogin(
    player.game_accounts ?? null,
    before.game_name,
    before.game_username,
  );
  const afterLogin = resolveGameLogin(
    player.game_accounts ?? null,
    after.game_name,
    after.game_username,
  );

  // Float: out with the old, in with the new, netted per game.
  const kiosk = new Map<string, { gameName: string; delta: number }>();
  const addKiosk = (gameName: string, delta: number) => {
    if (!gameName || delta === 0) return;
    const key = gameName.toLowerCase();
    const at = kiosk.get(key) ?? { gameName, delta: 0 };
    at.delta += delta;
    kiosk.set(key, at);
  };
  addKiosk(before.game_name, -before.credit_pulled_amount);
  addKiosk(after.game_name, after.credit_pulled_amount);
  for (const k of kiosk.values()) {
    await moveKioskCredit(txn, {
      companyEntityId: player.company_entity_id,
      gameName: k.gameName,
      delta: k.delta,
    });
  }

  // Wallet: put back what the pull actually took…
  if (walletDebited > 0) {
    await adjustGameCredit(txn, {
      playerId: before.player_id,
      gameName: before.game_name,
      gameUsername: beforeLogin,
      delta: walletDebited,
      nowIso,
    });
  }
  // …then take the new figure out of whatever that leaves.
  const [credit] = await txn
    .select()
    .from(gameCredits)
    .where(creditWhere(after.player_id, after.game_name, afterLogin))
    .for("update");
  const balance = credit?.current_balance ?? 0;
  const debited = Math.min(balance, after.credit_pulled_amount);
  if (credit && debited > 0) {
    await txn
      .update(gameCredits)
      .set({ current_balance: +(balance - debited).toFixed(2), last_updated_at: nowIso })
      .where(creditWhere(after.player_id, after.game_name, afterLogin));
  }

  await txn.insert(transactions).values({
    player_id: after.player_id,
    entity_id: player.company_entity_id,
    type: "credit_pull",
    amount: +(after.credit_pulled_amount - before.credit_pulled_amount).toFixed(2),
    game_name: after.game_name,
    reference_id: after.withdrawal_id,
    user_id: userId,
    details: {
      source: "manual",
      action: "rebooked_after_edit",
      from: { amount: before.credit_pulled_amount, game: before.game_name, login: beforeLogin },
      to: { amount: after.credit_pulled_amount, game: after.game_name, login: afterLogin },
      wallet_returned: walletDebited,
      wallet_debited: debited,
    },
  });
}

/**
 * Book a manual withdrawal as paid: the bank down, the member's total up.
 *
 * A manual row is typed after the work is done — the credit is out of the game
 * and the cash is out of the bank — so a row that names the account it was
 * paid from is finished, not half-done. Without this the balance only moved
 * when somebody remembered to press Paid, and "I entered a withdrawal and the
 * bank didn't change" was the result.
 *
 * Only when an account is named: with nothing to deduct the row stops at
 * credits_pulled, which is honest about what the CRM knows.
 */
export async function bookManualPayout(
  txn: Txn,
  input: {
    row: WithdrawalRow;
    player: PlayerRow;
    userId: number;
    nowIso?: string;
    // As bookManualPull: "paid_on_entry" unless a correction is re-laying it.
    action?: string;
  },
): Promise<WithdrawalRow> {
  const { row, player, userId } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (row.paid_from_account_id === null) return row;

  await moveBankBalance(txn, {
    accountId: row.paid_from_account_id,
    delta: -row.credit_pulled_amount,
  });

  const [updated] = await txn
    .update(withdrawals)
    // A correction that moves the payout keeps the moment it was first paid:
    // the cash left the bank then, whichever account it is now booked to.
    .set({ status: "paid", paid_at: row.paid_at ?? nowIso, updated_at: nowIso })
    .where(eq(withdrawals.withdrawal_id, row.withdrawal_id))
    .returning();

  await txn
    .update(players)
    .set({
      total_withdrawals: sql`${players.total_withdrawals} + ${row.credit_pulled_amount}`,
    })
    .where(eq(players.player_id, row.player_id));

  await txn.insert(transactions).values({
    player_id: row.player_id,
    entity_id: player.company_entity_id,
    type: "withdrawal",
    amount: row.credit_pulled_amount,
    game_name: row.game_name,
    reference_id: row.withdrawal_id,
    user_id: userId,
    details: {
      source: "manual",
      action: input.action ?? "paid_on_entry",
      paid_from_account_id: row.paid_from_account_id,
    },
  });

  return updated;
}

/**
 * Give back a manual payout: the member's total_withdrawals down by what the
 * payout raised it, and the bank repaid when the payout came out of one.
 *
 * The two are decided separately because they were booked separately. Every
 * route that marks a row paid raises the total — POST /:id/paid did so even
 * when no account was named, back when it allowed that — but only a payout
 * that named an account ever moved a bank. Tying the total to the account
 * left an account-less paid row's total raised for good: failing it kept the
 * figure, and filling Paid From later counted it twice.
 *
 * Writes no ledger row: the caller knows why the payout is being undone (a
 * delete, a status change, a corrected amount) and records that instead.
 */
export async function reverseManualPayout(
  txn: Txn,
  input: { row: WithdrawalRow },
): Promise<{ bankRepaid: boolean }> {
  const { row } = input;
  if (row.status !== "paid") return { bankRepaid: false };
  const pulled = row.credit_pulled_amount;
  await txn
    .update(players)
    .set({ total_withdrawals: sql`${players.total_withdrawals} - ${pulled}` })
    .where(eq(players.player_id, row.player_id));
  if (row.paid_from_account_id === null) return { bankRepaid: false };
  await moveBankBalance(txn, { accountId: row.paid_from_account_id, delta: pulled });
  return { bankRepaid: true };
}

/**
 * Give back a manual pull: the float gives up the credit the pull returned to
 * it, and the member's wallet gets back what the pull took out of it.
 *
 * The wallet is credited by exactly what the pull debited, not by the pulled
 * figure — bookManualPull caps its debit at what the cache actually held, so
 * refunding the full amount would invent credit the CRM never took away. That
 * figure is on the pull's latest ledger row (the entry pull, or the last
 * re-book after an edit); absent one, nothing was debited.
 *
 * Returns what went back into the wallet, for the caller's ledger row. A
 * caller that records the reversal as a `credit_pull` row must write
 * `wallet_debited: 0` on it, because this function — and the next one to
 * reverse the row — reads the latest such row to learn what is outstanding.
 */
export async function reverseManualPull(
  txn: Txn,
  input: { row: WithdrawalRow; player: PlayerRow; nowIso?: string },
): Promise<{ walletReturned: number }> {
  const { row, player } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const pulled = row.credit_pulled_amount;
  if (row.status !== "paid" && row.status !== "credits_pulled") return { walletReturned: 0 };
  if (pulled <= 0) return { walletReturned: 0 };

  await moveKioskCredit(txn, {
    companyEntityId: player.company_entity_id,
    gameName: row.game_name,
    delta: -pulled,
  });

  const debited = await walletDebitedByPull(txn, row.withdrawal_id);
  if (debited > 0) {
    const login = resolveGameLogin(player.game_accounts ?? null, row.game_name, row.game_username);
    await adjustGameCredit(txn, {
      playerId: row.player_id,
      gameName: row.game_name,
      gameUsername: login,
      delta: debited,
      nowIso,
    });
  }
  return { walletReturned: debited };
}

/**
 * Unwind a manual withdrawal completely, for a row being deleted.
 *
 * Whatever stage the row reached is given back in reverse order: the payout
 * first (if it got as far as `paid`), then the pull (if it was ever pulled).
 * Both halves are their own functions so a correction can undo just the one
 * it is changing — moving a payout to another account has no business
 * touching the kiosk float.
 */
export async function reverseManualWithdrawal(
  txn: Txn,
  input: { row: WithdrawalRow; player: PlayerRow; userId: number; nowIso?: string },
): Promise<void> {
  const { row, player } = input;
  await reverseManualPayout(txn, { row });
  await reverseManualPull(txn, { row, player, nowIso: input.nowIso });
}

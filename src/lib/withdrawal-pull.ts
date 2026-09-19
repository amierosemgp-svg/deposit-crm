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
      action: "pulled_on_entry",
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

  const [pull] = await txn
    .select({ details: transactions.details })
    .from(transactions)
    .where(
      and(
        eq(transactions.reference_id, before.withdrawal_id),
        eq(transactions.type, "credit_pull"),
      ),
    )
    .orderBy(desc(transactions.transaction_id))
    .limit(1);
  const walletDebited =
    (pull?.details as { wallet_debited?: number } | undefined)?.wallet_debited ?? 0;

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
  input: { row: WithdrawalRow; player: PlayerRow; userId: number; nowIso?: string },
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
    .set({ status: "paid", paid_at: nowIso, updated_at: nowIso })
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
      action: "paid_on_entry",
      paid_from_account_id: row.paid_from_account_id,
    },
  });

  return updated;
}

/**
 * Unwind a manual withdrawal completely, for a row being deleted.
 *
 * Whatever stage the row reached is given back in reverse order: the bank is
 * repaid what it paid out and the member's total_withdrawals drops (if it got
 * as far as `paid`), then the float gives up the credit the pull returned to
 * it and the member's wallet gets that credit back (if it was ever pulled).
 *
 * The wallet is credited by exactly what the pull debited, not by the pulled
 * figure — bookManualPull caps its debit at what the cache actually held, so
 * refunding the full amount would invent credit the CRM never took away. That
 * figure is on the pull's own ledger row; absent one, nothing was debited.
 */
export async function reverseManualWithdrawal(
  txn: Txn,
  input: { row: WithdrawalRow; player: PlayerRow; userId: number; nowIso?: string },
): Promise<void> {
  const { row, player } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const pulled = row.credit_pulled_amount;

  if (row.status === "paid" && row.paid_from_account_id !== null) {
    await moveBankBalance(txn, { accountId: row.paid_from_account_id, delta: pulled });
    await txn
      .update(players)
      .set({ total_withdrawals: sql`${players.total_withdrawals} - ${pulled}` })
      .where(eq(players.player_id, row.player_id));
  }

  if (row.status !== "paid" && row.status !== "credits_pulled") return;
  if (pulled <= 0) return;

  await moveKioskCredit(txn, {
    companyEntityId: player.company_entity_id,
    gameName: row.game_name,
    delta: -pulled,
  });

  const [pull] = await txn
    .select({ details: transactions.details })
    .from(transactions)
    .where(
      and(
        eq(transactions.reference_id, row.withdrawal_id),
        eq(transactions.type, "credit_pull"),
      ),
    )
    .orderBy(desc(transactions.transaction_id))
    .limit(1);
  const debited = Number(
    (pull?.details as { wallet_debited?: number } | undefined)?.wallet_debited ?? 0,
  );
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
}

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts } from "@/db/schema";

type Txn = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The account can't cover the debit. Callers map this to a 422. */
export class InsufficientBankBalanceError extends Error {}

/**
 * Move a company bank account's balance, under a lock.
 *
 * Anything that takes money out of an account goes through here: a payout, a
 * leader's cash withdrawal, an expense. Before this, expenses recorded which
 * account paid them and then left the balance alone, so the CRM's figure drifted
 * above the bank's by every expense ever recorded.
 *
 * Refuses to go below zero, as transfers and cash-outs already do. A charge the
 * balance can't cover means the recorded balance is behind the bank, and the
 * honest order is to correct the balance first rather than push it negative.
 */
export async function moveBankBalance(
  txn: Txn,
  input: { accountId: number; delta: number },
): Promise<number> {
  const { accountId, delta } = input;
  if (delta === 0) return 0;

  const [account] = await txn
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.account_id, accountId))
    .for("update");
  if (!account) throw new InsufficientBankBalanceError("Bank account not found");

  const next = +(account.current_balance + delta).toFixed(2);
  if (next < 0) {
    throw new InsufficientBankBalanceError(
      `${account.bank_name} ${account.account_number} holds ` +
        `${account.current_balance.toFixed(2)}, which doesn't cover ${Math.abs(delta).toFixed(2)}`,
    );
  }

  await txn
    .update(bankAccounts)
    .set({ current_balance: next })
    .where(eq(bankAccounts.account_id, accountId));
  return next;
}

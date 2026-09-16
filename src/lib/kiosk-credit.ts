import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { providerBoAccounts } from "@/db/schema";

/**
 * The company's credit pool at one kiosk, and the two directions it moves.
 *
 * A kiosk holds a float the house has bought from the provider. Topping a
 * player up spends it; pulling a player's remaining credit back returns it.
 * Only the spending half was ever written — deposits, referral payouts and
 * free credits all debited the pool, and nothing credited it — so every
 * withdrawal quietly shrank the recorded float against the real one. Over
 * RajaClub's first imported month that gap would have been RM 767,529.
 *
 * Both directions now go through here, so the pair cannot drift apart again.
 */

type Tx = Pick<typeof db, "select" | "update">;

/** The pool can't cover a debit. Callers map this to a 422. */
export class InsufficientKioskCreditError extends Error {}

/**
 * Move a company's kiosk float. Positive returns credit, negative spends it.
 *
 * Silently does nothing when the company has no kiosk row for that game: a
 * house that has not registered its back-office accounts is not tracking a
 * float, and refusing the withdrawal over it would block CS from paying a
 * player over bookkeeping they never opted into. Returns what moved, so the
 * caller can say whether it did.
 */
export async function moveKioskCredit(
  txn: Tx,
  input: {
    companyEntityId: number | null;
    gameName: string | null;
    /** Positive = back into the pool, negative = out of it. */
    delta: number;
  },
): Promise<number> {
  const { companyEntityId, gameName, delta } = input;
  if (companyEntityId === null || !gameName || delta === 0) return 0;

  const [bo] = await txn
    .select()
    .from(providerBoAccounts)
    .where(
      and(
        eq(providerBoAccounts.company_entity_id, companyEntityId),
        eq(providerBoAccounts.game_name, gameName),
        eq(providerBoAccounts.status, "active"),
      ),
    )
    .for("update");
  if (!bo) return 0;

  const next = +(bo.current_credit + delta).toFixed(2);
  if (next < 0) {
    throw new InsufficientKioskCreditError(
      `Insufficient BO credit for ${gameName} ` +
        `(${bo.current_credit.toFixed(2)} available, ${Math.abs(delta).toFixed(2)} needed)`,
    );
  }

  await txn
    .update(providerBoAccounts)
    .set({ current_credit: next })
    .where(eq(providerBoAccounts.bo_account_id, bo.bo_account_id));
  return delta;
}

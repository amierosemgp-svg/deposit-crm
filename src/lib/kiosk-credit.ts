import { and, asc, desc, eq } from "drizzle-orm";
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

  /**
   * A company can hold more than one back-office login for the same game —
   * RajaClub runs two on five of theirs, and in every pair one sits empty.
   * Taking whichever row the database happened to return first meant a top-up
   * could be refused for want of credit while the game's other account held
   * RM 24,050, or be charged to an account that wasn't the one CS used.
   *
   * So the accounts are read as one float, richest first, and a debit comes
   * out of the first account that can cover it on its own. Never split across
   * two: each row mirrors a real back-office balance CS tops up by hand, and a
   * half-here-half-there debit matches neither of them. When no single account
   * can cover it the caller is told what each holds.
   */
  const rows = await txn
    .select()
    .from(providerBoAccounts)
    .where(
      and(
        eq(providerBoAccounts.company_entity_id, companyEntityId),
        eq(providerBoAccounts.game_name, gameName),
        eq(providerBoAccounts.status, "active"),
      ),
    )
    .orderBy(desc(providerBoAccounts.current_credit), asc(providerBoAccounts.bo_account_id))
    .for("update");
  if (!rows.length) return 0;

  // Returning credit goes to the account holding the most — the same one a
  // debit would have come from, so a pull and its top-up meet in one place.
  const bo = delta > 0 ? rows[0] : rows.find((r) => r.current_credit + delta >= 0);
  if (!bo) {
    const held = rows
      .map((r) => `${r.bo_label ?? `#${r.bo_account_id}`} ${r.current_credit.toFixed(2)}`)
      .join(", ");
    throw new InsufficientKioskCreditError(
      `Insufficient BO credit for ${gameName} ` +
        `(${Math.abs(delta).toFixed(2)} needed; accounts hold ${held})`,
    );
  }

  const next = +(bo.current_credit + delta).toFixed(2);

  await txn
    .update(providerBoAccounts)
    .set({ current_credit: next })
    .where(eq(providerBoAccounts.bo_account_id, bo.bo_account_id));
  return delta;
}

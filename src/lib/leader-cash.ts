import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, bankCashOuts, leaderTransfers, users } from "@/db/schema";
import type { AuthedUser } from "./auth";

/**
 * A leader's cash on hand, now: the opening amount, plus the cash that has come
 * into their hands since, minus the cash that has left them.
 *
 *   cash now = opening + Clear Bank taken by them
 *                      + transfers received from another leader
 *                      − transfers paid to another leader
 *
 * Between two leaders the whole amount moves, whatever the ends are: paying
 * Tiong out of a company account still comes off KC's figure and onto Tiong's.
 * A leader's move to themselves (their bank → their cash) only counts its Cash
 * end, or it would add and take off the same sum and never show.
 *
 * Only what happened at or after opening_cash_at counts. The opening is what
 * they held on the day it was entered, so anything earlier is already in it,
 * and counting it again would double it.
 *
 * Clear Bank (bank_cash_outs) names the taker as text — the sheet offers the
 * leaders by full name, and anything else typed is kept as written. A row
 * counts for a leader only when that text is exactly their name (any case):
 * "kc" could be any of three KCs, and "Clear Bank to mbb 2" is nobody's pocket.
 *
 * Not in here: expenses paid in cash.
 */

export type LeaderCashMovement = {
  /** Unique within one leader's list. */
  key: string;
  kind: "transfer" | "clear_bank";
  /** When the cash moved. */
  at: string;
  /** Signed: positive is cash received, negative is cash paid out. */
  amount: number;
  /** Transfers: the other leader, or the same one for their own bank ↔ cash. */
  counterparty_user_id: number | null;
  /** Clear Bank: the account the cash came out of. */
  account_label: string | null;
  note: string | null;
};

export type LeaderCash = {
  user_id: number;
  opening_cash: number | null;
  opening_cash_at: string | null;
  cash_in: number;
  cash_out: number;
  /** Null until an opening amount is entered — there is nothing to start from. */
  cash_now: number | null;
  movements: LeaderCashMovement[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const nameKey = (s: string) => s.trim().toLowerCase();

/** The leaders whose cash this user may see: an admin's organisation, or a leader's own. */
async function visibleLeaders(user: AuthedUser) {
  const base = db
    .select({
      user_id: users.user_id,
      full_name: users.full_name,
      entity_id: users.entity_id,
      opening_cash: users.opening_cash,
      opening_cash_at: users.opening_cash_at,
    })
    .from(users);
  if (user.role === "company_leader") {
    return base.where(eq(users.user_id, user.user_id));
  }
  if (user.role !== "super_admin" && user.role !== "viewer") return [];
  const leaders = await base.where(eq(users.role, "company_leader"));
  const owned = user.ownedEntityIds;
  return owned === null ? leaders : leaders.filter((l) => owned.includes(l.entity_id));
}

export async function leaderCash(user: AuthedUser): Promise<LeaderCash[]> {
  const leaders = await visibleLeaders(user);
  if (!leaders.length) return [];
  const ids = leaders.map((l) => l.user_id);

  // Two leaders with one name can't be told apart from a typed taker, so a
  // shared name claims no Clear Bank rows at all rather than the wrong person's.
  const allLeaderNames = await db
    .select({ full_name: users.full_name })
    .from(users)
    .where(eq(users.role, "company_leader"));
  const nameCount = new Map<string, number>();
  for (const { full_name } of allLeaderNames) {
    nameCount.set(nameKey(full_name), (nameCount.get(nameKey(full_name)) ?? 0) + 1);
  }
  const claimable = leaders
    .map((l) => nameKey(l.full_name))
    .filter((n) => n && nameCount.get(n) === 1);

  const [transfers, clears] = await Promise.all([
    db
      .select({
        transfer_id: leaderTransfers.transfer_id,
        from_id: leaderTransfers.from_leader_user_id,
        to_id: leaderTransfers.to_leader_user_id,
        amount: leaderTransfers.amount,
        from_cash: leaderTransfers.from_cash,
        to_cash: leaderTransfers.to_cash,
        note: leaderTransfers.note,
        created_at: leaderTransfers.created_at,
      })
      .from(leaderTransfers)
      .where(
        or(
          inArray(leaderTransfers.from_leader_user_id, ids),
          inArray(leaderTransfers.to_leader_user_id, ids),
        ),
      ),
    claimable.length
      ? db
          .select({
            cash_out_id: bankCashOuts.cash_out_id,
            amount: bankCashOuts.amount,
            taken_by: bankCashOuts.taken_by,
            occurred_at: bankCashOuts.occurred_at,
            notes: bankCashOuts.notes,
            label: bankAccounts.label,
            bank_name: bankAccounts.bank_name,
            account_number: bankAccounts.account_number,
          })
          .from(bankCashOuts)
          .innerJoin(bankAccounts, eq(bankAccounts.account_id, bankCashOuts.account_id))
          // A reversed Clear Bank put the money back in the bank; one taken by
          // an entity (a casino, a company) went to no leader's pocket.
          .where(and(isNull(bankCashOuts.reversed_at), isNull(bankCashOuts.taken_by_entity_id)))
      : Promise.resolve([]),
  ]);

  return leaders.map((l) => {
    const since = l.opening_cash_at ? Date.parse(l.opening_cash_at) : null;
    const counts = (at: string) => since === null || Date.parse(at) >= since;
    const movements: LeaderCashMovement[] = [];

    for (const r of transfers) {
      if (!counts(r.created_at)) continue;
      const own = r.from_id === r.to_id;
      // Another leader: the whole amount, either way. Their own move: the Cash end.
      if (r.to_id === l.user_id && (!own || r.to_cash)) {
        movements.push({
          key: `t${r.transfer_id}+`,
          kind: "transfer",
          at: r.created_at,
          amount: r.amount,
          counterparty_user_id: r.from_id,
          account_label: null,
          note: r.note,
        });
      }
      if (r.from_id === l.user_id && (!own || r.from_cash)) {
        movements.push({
          key: `t${r.transfer_id}-`,
          kind: "transfer",
          at: r.created_at,
          amount: -r.amount,
          counterparty_user_id: r.to_id,
          account_label: null,
          note: r.note,
        });
      }
    }

    const mine = nameKey(l.full_name);
    if (claimable.includes(mine)) {
      for (const c of clears) {
        if (nameKey(c.taken_by) !== mine || !counts(c.occurred_at)) continue;
        movements.push({
          key: `c${c.cash_out_id}`,
          kind: "clear_bank",
          at: c.occurred_at,
          amount: c.amount,
          counterparty_user_id: null,
          account_label: c.label ?? `${c.bank_name} ${c.account_number}`,
          note: c.notes,
        });
      }
    }

    movements.sort((a, b) => b.at.localeCompare(a.at));
    const cash_in = round2(movements.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0));
    const cash_out = round2(-movements.filter((m) => m.amount < 0).reduce((s, m) => s + m.amount, 0));
    return {
      user_id: l.user_id,
      opening_cash: l.opening_cash,
      opening_cash_at: l.opening_cash_at,
      cash_in,
      cash_out,
      cash_now: l.opening_cash == null ? null : round2(l.opening_cash + cash_in - cash_out),
      movements,
    };
  });
}

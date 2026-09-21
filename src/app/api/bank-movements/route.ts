import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError, visibleEntityIds } from "@/lib/api-helpers";
import { all, businessDay, inList } from "@/lib/report-sql";

/**
 * GET /api/bank-movements?from=&to=&company= — what actually moved through each
 * bank account over a period.
 *
 * Six things move a bank balance, and the cards used to show none of them:
 *
 *   in    deposits received, leader transfers received, bank transfers received
 *   out   withdrawals paid, expenses paid, Clear Bank taken out,
 *         leader transfers sent, bank transfers sent
 *
 * Both cards previously showed `current_balance` filtered by the account's
 * collect/payout role. Every account at this operator is role `both`, so the
 * two filters selected the same accounts and the two cards printed the same
 * figure — and the figure was the balance, not the flow. The role flag cannot
 * answer this in principle: the account labelled "HLB Payout" has taken five
 * deposits and paid no withdrawals. So nothing here consults it. The
 * transaction knows which account it moved, and that is the only thing asked.
 *
 * Aggregated in SQL rather than in the browser because /api/state ships at most
 * 500 deposits. The card was counting from that slice and showing CIMB "33 dep"
 * against a real 1,393 for the month — a figure that was not wrong by a rounding
 * error but by a factor of forty, and that got worse as the desk got busier.
 *
 * Leaving out Clear Bank and expenses would understate outflow by about a
 * quarter (Clear Bank alone is ~31% of money leaving the banks), which is the
 * same class of unexplained difference the operator spent a week reconciling.
 */

/** Amounts a withdrawal really took: what was pulled, else what was asked. */
const WITHDRAWN = sql`coalesce(nullif(w.credit_pulled_amount, 0), w.requested_amount)`;

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sp = new URL(request.url).searchParams;
    const from = (sp.get("from") ?? "").trim() || null;
    const to = (sp.get("to") ?? "").trim() || null;
    const companyRaw = (sp.get("company") ?? "").trim();
    const companyId = companyRaw ? Number(companyRaw) : null;
    if (companyRaw && !Number.isInteger(companyId)) {
      return jsonError("Bad company");
    }
    const isDay = (v: string | null) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!isDay(from) || !isDay(to)) return jsonError("Bad date, expected YYYY-MM-DD");

    // Which accounts this user may see at all.
    const visible = await visibleEntityIds(user);
    if (visible !== null && visible.length === 0) return Response.json({ accounts: [] });
    const accountWhere: SQL[] = [sql`a.status = 'active'`];
    if (visible !== null) accountWhere.push(inList(sql`a.entity_id`, visible));
    if (companyId !== null) accountWhere.push(sql`a.entity_id = ${companyId}`);

    /**
     * One window clause per source, on the column that dates that movement in
     * the desk's own terms — a deposit by the day it is booked against, every-
     * thing else by when it happened. Read in Malaysia time so a row lands on
     * the same day here as it does on the sheet.
     */
    const window = (column: SQL) => {
      const parts: SQL[] = [];
      if (from) parts.push(sql`${businessDay(column)} >= ${from}::date`);
      if (to) parts.push(sql`${businessDay(column)} <= ${to}::date`);
      return all(parts);
    };

    /**
     * Every movement in the period, each tagged with where it came from, so
     * one pass answers both questions the panel asks: per account for the bank
     * cards, and per source for the Net card's breakdown.
     */
    /**
     * Each row carries a signed delta — what it did to the balance — and the
     * direction is read off that sign, not off the table it came from.
     *
     * This matters because the desk records a bank top-up as a Clear Bank row
     * with a NEGATIVE amount ("Backup From TTT", "Backup to from old ambb 2"):
     * 33 such rows, RM 63,187.72, money arriving through the outflow table. A
     * few expenses are negative too, for the same reason — a refund. Taking
     * "it is in bank_cash_outs, therefore it is money out" would print a
     * negative figure on a card that can only mean a positive amount, and the
     * two cards would each be wrong while the net stayed right.
     *
     * Reading the sign puts every one of them on the correct card with the
     * correct figure, and needs no cleanup of what the desk has already keyed.
     */
    const signed = sql`
      SELECT d.received_into_account_id AS account_id,
             d.deposit_amount           AS delta,
             'deposit'                  AS source,
             d.bonus_amount             AS bonus
        FROM deposits d
       WHERE d.status = 'completed'
         AND d.received_into_account_id IS NOT NULL
         AND ${window(sql`d.deposit_date`)}

      UNION ALL
      SELECT w.paid_from_account_id, -(${WITHDRAWN}), 'withdrawal', 0
        FROM withdrawals w
       WHERE w.status = 'paid'
         AND w.paid_from_account_id IS NOT NULL
         AND ${window(sql`w.created_at`)}

      UNION ALL
      SELECT e.paid_from_account_id, -e.amount, 'expense', 0
        FROM expenses e
       WHERE e.paid_from_account_id IS NOT NULL
         AND ${window(sql`e.created_at`)}

      UNION ALL
      SELECT c.account_id, -c.amount, 'clear_bank', 0
        FROM bank_cash_outs c
       WHERE c.reversed_at IS NULL
         AND ${window(sql`c.occurred_at`)}

      -- A settlement or an internal move is two movements, one per end.
      UNION ALL
      SELECT t.from_account_id, -t.amount, 'leader_transfer', 0
        FROM leader_transfers t
       WHERE t.from_account_id IS NOT NULL AND ${window(sql`t.created_at`)}
      UNION ALL
      SELECT t.to_account_id, t.amount, 'leader_transfer', 0
        FROM leader_transfers t
       WHERE t.to_account_id IS NOT NULL AND ${window(sql`t.created_at`)}

      UNION ALL
      SELECT b.from_account_id, -b.amount, 'bank_transfer', 0
        FROM bank_transfers b
       WHERE b.status = 'confirmed' AND ${window(sql`b.created_at`)}
      UNION ALL
      SELECT b.to_account_id, b.amount, 'bank_transfer', 0
        FROM bank_transfers b
       WHERE b.status = 'confirmed' AND ${window(sql`b.created_at`)}
    `;

    const movement = sql`
      SELECT s.account_id,
             abs(s.delta)                                        AS amount,
             CASE WHEN s.delta >= 0 THEN 'in' ELSE 'out' END     AS direction,
             s.source,
             s.bonus
        FROM (${signed}) s
       WHERE s.account_id IS NOT NULL
    `;

    const rows = await db.execute(sql`
      WITH movement AS (${movement})
      SELECT a.account_id::int                                          AS account_id,
             a.entity_id::int                                           AS entity_id,
             a.bank_name                                                AS bank_name,
             a.label                                                    AS label,
             a.role::text                                               AS role,
             a.current_balance::float8                                  AS balance,
             a.opening_balance::float8                                  AS opening_balance,
             a.opening_balance_at                                       AS opening_balance_at,
             coalesce(sum(m.amount) FILTER (WHERE m.direction = 'in'), 0)::float8   AS in_amount,
             coalesce(sum(m.amount) FILTER (WHERE m.direction = 'out'), 0)::float8  AS out_amount,
             count(*) FILTER (WHERE m.direction = 'in')::int            AS in_count,
             count(*) FILTER (WHERE m.direction = 'out')::int           AS out_count
        FROM bank_accounts a
        LEFT JOIN movement m ON m.account_id = a.account_id
       WHERE ${all(accountWhere)}
       GROUP BY a.account_id, a.entity_id, a.bank_name, a.label, a.role,
                a.current_balance, a.opening_balance, a.opening_balance_at
    `);

    /**
     * The same movements totalled by source. Restricted to the accounts the
     * user can see through the same join, so the breakdown always adds up to
     * the two cards beside it rather than quietly counting a wider set.
     */
    const totals = await db.execute(sql`
      WITH movement AS (${movement})
      SELECT m.source                                  AS source,
             m.direction                               AS direction,
             count(*)::int                             AS count,
             coalesce(sum(m.amount), 0)::float8        AS amount,
             coalesce(sum(m.bonus), 0)::float8         AS bonus
        FROM movement m
        JOIN bank_accounts a ON a.account_id = m.account_id
       WHERE ${all(accountWhere)}
       GROUP BY m.source, m.direction
    `);

    return Response.json({
      accounts: rows.rows ?? rows,
      totals: totals.rows ?? totals,
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import {
  all,
  businessDay,
  RB_AT,
  DEPOSIT_COUNTS,
  parseReportParams,
  scopeByPlayerAsOf,
  scopeDepositsAsOf,
  WITHDRAWAL_COUNTS,
} from "@/lib/report-sql";

/**
 * GET /api/reports/daily-report — the house's daily operating figures, one row
 * per day, in the shape of the worksheet they already keep.
 *
 *   total deposit · AP · NP · sales/day · sales (cumulative) · bank balance
 *
 * Their spreadsheet repeats these five columns for every company across the
 * page — 355 columns wide by August. A web table cannot be read that way, so
 * the company filter picks the block: one company shows that company's, "all"
 * shows the same rollup their sheet keeps at the bottom.
 *
 * Bank balance is reconstructed rather than stored. Only today's balance is
 * held on the account, so each day's closing figure is that number wound back
 * through every movement since — which is exact precisely because the bank
 * ledger already reconciles (see the RajaClub import).
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = parseReportParams(request.url);
    if ("error" in p) return jsonError(p.error);

    const dw: SQL[] = [...scopeDepositsAsOf(user, sql`d.deposit_date`), DEPOSIT_COUNTS];
    if (p.from) dw.push(sql`${businessDay(sql`d.deposit_date`)} >= ${p.from}::date`);
    if (p.to) dw.push(sql`${businessDay(sql`d.deposit_date`)} <= ${p.to}::date`);
    if (p.companyId !== null) dw.push(sql`d.company_entity_id = ${p.companyId}`);

    const ww: SQL[] = [...scopeByPlayerAsOf(user, sql`wd.created_at`), WITHDRAWAL_COUNTS];
    if (p.from) ww.push(sql`${businessDay(sql`wd.created_at`)} >= ${p.from}::date`);
    if (p.to) ww.push(sql`${businessDay(sql`wd.created_at`)} <= ${p.to}::date`);
    if (p.companyId !== null) ww.push(sql`pl.company_entity_id = ${p.companyId}`);

    // Free credit has no table: it is a game_topup ledger row with no deposit
    // behind it. Money given away all the same, so it belongs in sales.
    const fw: SQL[] = [sql`t.details->>'kind' = 'free_credit'`];
    if (p.from) fw.push(sql`${businessDay(sql`t.created_at`)} >= ${p.from}::date`);
    if (p.to) fw.push(sql`${businessDay(sql`t.created_at`)} <= ${p.to}::date`);
    if (p.companyId !== null) fw.push(sql`t.entity_id = ${p.companyId}`);
    else if (user.ownedEntityIds !== null) {
      fw.push(
        sql`t.entity_id IN (${sql.join(
          user.ownedEntityIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    }

    // Recommend bonuses are money out too, and touch no deposit row — left out,
    // the result is overstated by everything ever paid to an upline.
    const rw: SQL[] = [...scopeByPlayerAsOf(user, RB_AT, "up"), sql`rb.status = 'assigned'`];
    if (p.from) rw.push(sql`${businessDay(RB_AT)} >= ${p.from}::date`);
    if (p.to) rw.push(sql`${businessDay(RB_AT)} <= ${p.to}::date`);
    if (p.companyId !== null) rw.push(sql`up.company_entity_id = ${p.companyId}`);

    // Bank accounts whose movements make up the balance line.
    const bankScope =
      p.companyId !== null
        ? sql`ba.entity_id = ${p.companyId}`
        : user.ownedEntityIds !== null
          ? sql`ba.entity_id IN (${sql.join(
              user.ownedEntityIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql`true`;

    const res = await db.execute(sql`
      WITH dep AS (
        SELECT ${businessDay(sql`d.deposit_date`)}                 AS day,
               coalesce(sum(d.deposit_amount), 0)::float8          AS deposits,
               coalesce(sum(d.bonus_amount), 0)::float8            AS bonus,
               count(DISTINCT d.player_id)::int                    AS ap
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${all(dw)}
         GROUP BY 1
      ), wdr AS (
        SELECT ${businessDay(sql`wd.created_at`)}                  AS day,
               coalesce(sum(wd.credit_pulled_amount), 0)::float8   AS withdrawals
          FROM withdrawals wd
          JOIN players pl ON pl.player_id = wd.player_id
         WHERE ${all(ww)}
         GROUP BY 1
      ), fc AS (
        SELECT ${businessDay(sql`t.created_at`)}                   AS day,
               coalesce(sum(t.amount), 0)::float8                  AS free_credit
          FROM transactions t
         WHERE ${all(fw)}
         GROUP BY 1
      ), rec AS (
        SELECT ${businessDay(RB_AT)}                               AS day,
               coalesce(sum(rb.bonus_amount), 0)::float8           AS recommend
          FROM referral_bonuses rb
          JOIN players up ON up.player_id = rb.upline_player_id
         WHERE ${all(rw)}
         GROUP BY 1
      ), np AS (
        -- A member counts as new on the day of their FIRST deposit ever, not
        -- the first one inside the report's window: a player who started in
        -- July is not new again because the window opens in August.
        SELECT first_day AS day, count(*)::int AS np FROM (
          SELECT d.player_id,
                 min(${businessDay(sql`d.deposit_date`)}) AS first_day
            FROM deposits d
           WHERE d.status <> 'failed' AND d.player_id IS NOT NULL
           GROUP BY 1
        ) firsts
         GROUP BY 1
      ), days AS (
        SELECT day FROM dep
        UNION SELECT day FROM wdr
        UNION SELECT day FROM fc
        UNION SELECT day FROM rec
      )
      SELECT s.day,
             coalesce(dep.deposits, 0)      AS deposits,
             coalesce(dep.ap, 0)            AS ap,
             coalesce(np.np, 0)             AS np,
             coalesce(dep.bonus, 0)         AS bonus,
             coalesce(wdr.withdrawals, 0)   AS withdrawals,
             coalesce(fc.free_credit, 0)    AS free_credit,
             coalesce(rec.recommend, 0)     AS recommend,
             coalesce(dep.deposits, 0)
               - coalesce(wdr.withdrawals, 0)
               - coalesce(dep.bonus, 0)
               - coalesce(rec.recommend, 0)
               - coalesce(fc.free_credit, 0)                       AS sales,
             sum(coalesce(dep.deposits, 0)
                 - coalesce(wdr.withdrawals, 0)
                 - coalesce(dep.bonus, 0)
                 - coalesce(rec.recommend, 0)
                 - coalesce(fc.free_credit, 0))
               OVER (ORDER BY s.day)                               AS sales_cumulative,
             -- Today's balance wound back through everything that has moved
             -- since the end of this day.
             (SELECT coalesce(sum(ba.current_balance), 0)::float8
                FROM bank_accounts ba WHERE ${bankScope})
             - coalesce((SELECT sum(d2.deposit_amount)::float8 FROM deposits d2
                          WHERE d2.status <> 'failed'
                            AND ${businessDay(sql`d2.deposit_date`)} > s.day
                            AND d2.received_into_account_id IN
                                (SELECT ba.account_id FROM bank_accounts ba WHERE ${bankScope})), 0)
             + coalesce((SELECT sum(w2.credit_pulled_amount)::float8 FROM withdrawals w2
                          WHERE w2.status = 'paid'
                            AND ${businessDay(sql`w2.created_at`)} > s.day
                            AND w2.paid_from_account_id IN
                                (SELECT ba.account_id FROM bank_accounts ba WHERE ${bankScope})), 0)
             + coalesce((SELECT sum(c2.amount)::float8 FROM bank_cash_outs c2
                          WHERE ${businessDay(sql`c2.occurred_at`)} > s.day
                            AND c2.account_id IN
                                (SELECT ba.account_id FROM bank_accounts ba WHERE ${bankScope})), 0)
                                                                    AS bank_balance
        FROM days s
        LEFT JOIN dep ON dep.day = s.day
        LEFT JOIN wdr ON wdr.day = s.day
        LEFT JOIN fc  ON fc.day  = s.day
        LEFT JOIN rec ON rec.day = s.day
        LEFT JOIN np  ON np.day  = s.day
       ORDER BY s.day`);

    const rows = res.rows as unknown as {
      deposits: number;
      ap: number;
      np: number;
      bonus: number;
      withdrawals: number;
      free_credit: number;
      recommend: number;
      sales: number;
    }[];
    const add = (f: (r: (typeof rows)[number]) => number) =>
      rows.reduce((acc, r) => acc + Number(f(r)), 0);

    return Response.json({
      summary: {
        days: rows.length,
        deposits: add((r) => r.deposits),
        bonus: add((r) => r.bonus),
        withdrawals: add((r) => r.withdrawals),
        free_credit: add((r) => r.free_credit),
        recommend: add((r) => r.recommend),
        sales: add((r) => r.sales),
        np: add((r) => r.np),
        // Averaged per day, as their sheet's "average" row does. AP is not
        // summed: the same member active on ten days is one player, not ten.
        avg_deposits: rows.length ? add((r) => r.deposits) / rows.length : 0,
        avg_ap: rows.length ? add((r) => r.ap) / rows.length : 0,
      },
      rows: res.rows,
      total: res.rows.length,
      limit: res.rows.length,
      offset: 0,
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

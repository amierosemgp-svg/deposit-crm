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
 * GET /api/reports/sales-report — the same figures as the daily report, turned
 * ninety degrees: one row per company for the whole period.
 *
 * Their worksheet answers "how did today go" by reading across 355 columns.
 * This answers the question that costs them the reading: which companies are
 * carrying the month and which are not. Same arithmetic underneath, so the two
 * reports always add up to each other.
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

    const fw: SQL[] = [sql`t.details->>'kind' = 'free_credit'`, sql`t.entity_id IS NOT NULL`];
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

    // How many days the period covers, for the per-day average. Taken from the
    // filter rather than from the rows: a company that took nothing on Sunday
    // still had a Sunday.
    const spanDays =
      p.from && p.to
        ? Math.max(
            1,
            Math.round(
              (Date.parse(p.to) - Date.parse(p.from)) / 86_400_000,
            ) + 1,
          )
        : null;

    const res = await db.execute(sql`
      WITH dep AS (
        SELECT d.company_entity_id                          AS company_id,
               coalesce(sum(d.deposit_amount), 0)::float8   AS deposits,
               coalesce(sum(d.bonus_amount), 0)::float8     AS bonus,
               count(*)::int                                AS deposit_count,
               count(DISTINCT d.player_id)::int             AS ap
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${all(dw)} AND d.company_entity_id IS NOT NULL
         GROUP BY 1
      ), wdr AS (
        SELECT pl.company_entity_id                               AS company_id,
               coalesce(sum(wd.credit_pulled_amount), 0)::float8   AS withdrawals,
               count(*)::int                                       AS withdrawal_count
          FROM withdrawals wd
          JOIN players pl ON pl.player_id = wd.player_id
         WHERE ${all(ww)} AND pl.company_entity_id IS NOT NULL
         GROUP BY 1
      ), fc AS (
        SELECT t.entity_id                                   AS company_id,
               coalesce(sum(t.amount), 0)::float8            AS free_credit
          FROM transactions t
         WHERE ${all(fw)}
         GROUP BY 1
      ), rec AS (
        SELECT up.company_entity_id                        AS company_id,
               coalesce(sum(rb.bonus_amount), 0)::float8   AS recommend
          FROM referral_bonuses rb
          JOIN players up ON up.player_id = rb.upline_player_id
         WHERE ${all(rw)} AND up.company_entity_id IS NOT NULL
         GROUP BY 1
      ), np AS (
        -- New in the period: members whose first deposit ever falls inside it.
        SELECT f.company_entity_id AS company_id, count(*)::int AS np FROM (
          SELECT DISTINCT ON (d.player_id)
                 d.player_id, d.company_entity_id,
                 ${businessDay(sql`d.deposit_date`)} AS first_day
            FROM deposits d
           WHERE d.status <> 'failed' AND d.player_id IS NOT NULL
           ORDER BY d.player_id, d.deposit_date
        ) f
         WHERE (${p.from ?? null}::date IS NULL OR f.first_day >= ${p.from ?? null}::date)
           AND (${p.to ?? null}::date IS NULL OR f.first_day <= ${p.to ?? null}::date)
           AND f.company_entity_id IS NOT NULL
         GROUP BY 1
      ), ids AS (
        SELECT company_id FROM dep
        UNION SELECT company_id FROM wdr
        UNION SELECT company_id FROM fc
        UNION SELECT company_id FROM rec
      )
      SELECT i.company_id,
             coalesce(e.name, '#' || i.company_id)   AS company_name,
             coalesce(dep.deposits, 0)               AS deposits,
             coalesce(dep.deposit_count, 0)          AS deposit_count,
             coalesce(dep.ap, 0)                     AS ap,
             coalesce(np.np, 0)                      AS np,
             coalesce(dep.bonus, 0)                  AS bonus,
             coalesce(fc.free_credit, 0)             AS free_credit,
             coalesce(wdr.withdrawals, 0)            AS withdrawals,
             coalesce(wdr.withdrawal_count, 0)       AS withdrawal_count,
             coalesce(rec.recommend, 0)              AS recommend,
             coalesce(dep.deposits, 0) - coalesce(wdr.withdrawals, 0)
               - coalesce(dep.bonus, 0) - coalesce(rec.recommend, 0)
               - coalesce(fc.free_credit, 0)           AS sales
        FROM ids i
        LEFT JOIN dep ON dep.company_id = i.company_id
        LEFT JOIN wdr ON wdr.company_id = i.company_id
        LEFT JOIN fc  ON fc.company_id  = i.company_id
        LEFT JOIN rec ON rec.company_id = i.company_id
        LEFT JOIN np  ON np.company_id  = i.company_id
        LEFT JOIN entities e ON e.entity_id = i.company_id
       ORDER BY sales DESC`);

    const rows = res.rows as unknown as Record<string, number>[];
    const add = (k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

    return Response.json({
      summary: {
        companies: rows.length,
        deposits: add("deposits"),
        bonus: add("bonus"),
        free_credit: add("free_credit"),
        recommend: add("recommend"),
        withdrawals: add("withdrawals"),
        sales: add("sales"),
        ap: add("ap"),
        np: add("np"),
        days: spanDays ?? 0,
        sales_per_day: spanDays ? add("sales") / spanDays : 0,
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

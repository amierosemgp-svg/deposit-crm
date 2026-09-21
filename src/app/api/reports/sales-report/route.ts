import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import {
  IS_FREE_CREDIT,
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
 *
 * `?group=day` turns one company's row into its days — the drilldown behind
 * clicking a row. It is the same query with the grouping key swapped, so a
 * company's days always sum back to the row they came from; writing the
 * breakdown as its own query is how the two quietly drift apart.
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

    const fw: SQL[] = [IS_FREE_CREDIT, sql`t.entity_id IS NOT NULL`];
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

    /**
     * What each row stands for: a company, or a day of one company.
     *
     * Carried as text so both shapes share one query — the alternative is two
     * near-identical queries that have to be kept in step by hand. Each source
     * is grouped by its own date column, the one that decides which day a row
     * belongs to on the sheet.
     */
    const byDay = new URL(request.url).searchParams.get("group") === "day";
    const key = (companyColumn: SQL, dateColumn: SQL) =>
      byDay ? sql`${businessDay(dateColumn)}::text` : sql`${companyColumn}::text`;

    const res = await db.execute(sql`
      WITH dep AS (
        SELECT ${key(sql`d.company_entity_id`, sql`d.deposit_date`)} AS k,
               coalesce(sum(d.deposit_amount), 0)::float8   AS deposits,
               coalesce(sum(d.bonus_amount), 0)::float8     AS bonus,
               count(*)::int                                AS deposit_count,
               count(DISTINCT d.player_id)::int             AS ap
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${all(dw)} AND d.company_entity_id IS NOT NULL
         GROUP BY 1
      ), wdr AS (
        SELECT ${key(sql`pl.company_entity_id`, sql`wd.created_at`)} AS k,
               coalesce(sum(wd.credit_pulled_amount), 0)::float8   AS withdrawals,
               count(*)::int                                       AS withdrawal_count
          FROM withdrawals wd
          JOIN players pl ON pl.player_id = wd.player_id
         WHERE ${all(ww)} AND pl.company_entity_id IS NOT NULL
         GROUP BY 1
      ), fc AS (
        SELECT ${key(sql`t.entity_id`, sql`t.created_at`)}    AS k,
               coalesce(sum(t.amount), 0)::float8            AS free_credit
          FROM transactions t
         WHERE ${all(fw)}
         GROUP BY 1
      ), rec AS (
        SELECT ${key(sql`up.company_entity_id`, RB_AT)}    AS k,
               coalesce(sum(rb.bonus_amount), 0)::float8   AS recommend
          FROM referral_bonuses rb
          JOIN players up ON up.player_id = rb.upline_player_id
         WHERE ${all(rw)} AND up.company_entity_id IS NOT NULL
         GROUP BY 1
      ), np AS (
        -- New in the period: members whose first deposit ever falls inside it.
        -- By day, a member is new on the day they first deposited, so the days
        -- sum back to the company's figure with nobody counted twice.
        SELECT ${
          byDay
            ? sql`f.first_day::text`
            : sql`f.company_entity_id::text`
        } AS k, count(*)::int AS np FROM (
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
           ${
             p.companyId !== null
               ? sql`AND f.company_entity_id = ${p.companyId}`
               : sql``
           }
         GROUP BY 1
      ), ids AS (
        SELECT k FROM dep
        UNION SELECT k FROM wdr
        UNION SELECT k FROM fc
        UNION SELECT k FROM rec
      )
      SELECT i.k                                     AS company_id,
             ${
               byDay
                 ? sql`i.k`
                 : sql`coalesce(e.name, '#' || i.k)`
             }                                       AS company_name,
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
        LEFT JOIN dep ON dep.k = i.k
        LEFT JOIN wdr ON wdr.k = i.k
        LEFT JOIN fc  ON fc.k  = i.k
        LEFT JOIN rec ON rec.k = i.k
        LEFT JOIN np  ON np.k  = i.k
        ${
          byDay
            ? sql``
            : sql`LEFT JOIN entities e ON e.entity_id = i.k::int`
        }
       -- Days read in order; companies read biggest first.
       ORDER BY ${byDay ? sql`i.k` : sql`sales DESC`}`);

    const rows = res.rows as unknown as Record<string, number>[];
    const add = (k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

    /**
     * Active players, counted once over the whole period.
     *
     * Every other figure here is a sum, so adding the rows up gives the right
     * answer. This one is a distinct count, and distinct counts do not add: a
     * member who deposited on eight days is one active player, not eight. By
     * company that never showed, because a member sits under one company and
     * the sum happened to be right; grouped by day it overstated Pokercity's
     * 414 as 1,516. Asked of the period directly, both shapes agree, and a
     * company's drilldown reports the same AP as the row it was opened from.
     */
    const apRes = await db.execute(sql`
      SELECT count(DISTINCT d.player_id)::int AS ap
        FROM deposits d
        LEFT JOIN players pl ON pl.player_id = d.player_id
       WHERE ${all(dw)} AND d.company_entity_id IS NOT NULL`);
    const ap = Number((apRes.rows as unknown as { ap: number }[])[0]?.ap ?? 0);

    return Response.json({
      summary: {
        companies: rows.length,
        deposits: add("deposits"),
        bonus: add("bonus"),
        free_credit: add("free_credit"),
        recommend: add("recommend"),
        withdrawals: add("withdrawals"),
        sales: add("sales"),
        ap,
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

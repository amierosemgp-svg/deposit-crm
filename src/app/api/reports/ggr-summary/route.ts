import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import {
  all,
  businessDay,
  parseReportParams,
  scopeByPlayerAsOf,
  scopeDepositsAsOf,
  searchAcross,
} from "@/lib/report-sql";

/**
 * GET /api/reports/ggr-summary — per-company gross gaming revenue.
 *
 * Realised money only, matching the Dashboard's profit tile: completed
 * deposits and paid withdrawals, at the amount actually paid rather than the
 * amount asked for. Recommend bonuses are money out too and are invisible
 * otherwise — they are paid to the upline and never touch a deposit row.
 *
 * One row per company, so there is nothing to page: the whole result is the
 * answer. What made this wrong before was the *input*, not the size of the
 * output — the browser was aggregating over the newest 500 deposits.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = parseReportParams(request.url);
    if ("error" in p) return jsonError(p.error);

    // ── deposits: completed only ─────────────────────────────────────────────
    const dw: SQL[] = [
      ...scopeDepositsAsOf(user, sql`d.deposit_date`),
      sql`d.status = 'completed'`,
    ];
    if (p.from) dw.push(sql`${businessDay(sql`d.deposit_date`)} >= ${p.from}::date`);
    if (p.to) dw.push(sql`${businessDay(sql`d.deposit_date`)} <= ${p.to}::date`);
    if (p.companyId !== null) dw.push(sql`d.company_entity_id = ${p.companyId}`);
    if (p.status !== "all") dw.push(sql`d.status::text = ${p.status}`);
    if (p.q) {
      dw.push(
        searchAcross(
          sql`concat_ws(' ', d.transaction_ref, d.player_username, pl.full_name,
              pl.username, d.bank_name, d.bank_account_holder, d.bank_description,
              d.selected_game, d.game_topup_reference)`,
          p.q,
        ),
      );
    }

    // ── withdrawals: paid only, at what actually left the wallet ─────────────
    const ww: SQL[] = [
      ...scopeByPlayerAsOf(user, sql`wd.created_at`),
      sql`wd.status = 'paid'`,
    ];
    if (p.from) ww.push(sql`${businessDay(sql`wd.created_at`)} >= ${p.from}::date`);
    if (p.to) ww.push(sql`${businessDay(sql`wd.created_at`)} <= ${p.to}::date`);
    if (p.companyId !== null) ww.push(sql`pl.company_entity_id = ${p.companyId}`);
    if (p.status !== "all") ww.push(sql`wd.status::text = ${p.status}`);
    if (p.q) {
      ww.push(
        searchAcross(
          sql`concat_ws(' ', pl.full_name, pl.username, wd.game_name,
              wd.bank_name, wd.bank_account_number)`,
          p.q,
        ),
      );
    }

    // ── recommend bonuses: credited to the upline, so the upline's company ───
    const rbAt = sql`coalesce(rb.assigned_at, rb.created_at)`;
    const rw: SQL[] = [
      ...scopeByPlayerAsOf(user, rbAt, "up"),
      sql`rb.status = 'assigned'`,
    ];
    if (p.from) rw.push(sql`${businessDay(rbAt)} >= ${p.from}::date`);
    if (p.to) rw.push(sql`${businessDay(rbAt)} <= ${p.to}::date`);
    if (p.companyId !== null) rw.push(sql`up.company_entity_id = ${p.companyId}`);
    if (p.q) {
      rw.push(
        searchAcross(
          sql`concat_ws(' ', 'rec-' || rb.bonus_id, up.full_name, up.username,
              dn.full_name, dn.username, rb.game_name, rb.note)`,
          p.q,
        ),
      );
    }

    /**
     * Ownership rows overlapping the reported period.
     *
     * Built here rather than inline because an open-ended range needs the
     * clause dropped, not a NULL parameter — Postgres cannot infer a type for
     * a bare NULL and rejects the whole statement (42P18).
     */
    const overlapsPeriod = sql.join(
      [
        p.to ? sql`AND cl.valid_from <= (${p.to}::date + 1)` : undefined,
        p.from
          ? sql`AND (cl.valid_to IS NULL OR cl.valid_to > ${p.from}::date)`
          : undefined,
      ].filter((x): x is SQL => x !== undefined),
      sql` `,
    );

    const res = await db.execute(sql`
      WITH dep AS (
        SELECT d.company_entity_id                       AS company_id,
               count(*)::int                             AS dep_count,
               coalesce(sum(d.deposit_amount), 0)::float8 AS dep_volume,
               coalesce(sum(d.bonus_amount), 0)::float8   AS bonus
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${all(dw)} AND d.company_entity_id IS NOT NULL
         GROUP BY 1
      ), wdr AS (
        SELECT pl.company_entity_id                            AS company_id,
               count(*)::int                                   AS wd_count,
               coalesce(sum(wd.credit_pulled_amount), 0)::float8 AS wd_volume
          FROM withdrawals wd
          JOIN players pl ON pl.player_id = wd.player_id
         WHERE ${all(ww)} AND pl.company_entity_id IS NOT NULL
         GROUP BY 1
      ), rec AS (
        SELECT up.company_entity_id                       AS company_id,
               coalesce(sum(rb.bonus_amount), 0)::float8   AS bonus
          FROM referral_bonuses rb
          JOIN players up ON up.player_id = rb.upline_player_id
          LEFT JOIN players dn ON dn.player_id = rb.downline_player_id
         WHERE ${all(rw)} AND up.company_entity_id IS NOT NULL
         GROUP BY 1
      ), ids AS (
        SELECT company_id FROM dep
        UNION SELECT company_id FROM wdr
        UNION SELECT company_id FROM rec
      )
      SELECT i.company_id,
             coalesce(e.name, '#' || i.company_id)                AS company_name,
             -- Who ran it during the period, not who runs it today. A company
             -- handed over mid-month names both, which is the honest answer;
             -- splitting the money between them is not something the ownership
             -- record claims to know.
             (SELECT string_agg(DISTINCT le.name, ', ')
                FROM company_leaders cl
                JOIN entities le ON le.entity_id = cl.leader_entity_id
               WHERE cl.company_entity_id = i.company_id
                 ${overlapsPeriod}
             )                                                    AS leaders,
             coalesce(dep.dep_count, 0)                           AS dep_count,
             coalesce(dep.dep_volume, 0)                          AS dep_volume,
             coalesce(dep.bonus, 0) + coalesce(rec.bonus, 0)      AS bonus,
             coalesce(wdr.wd_count, 0)                            AS wd_count,
             coalesce(wdr.wd_volume, 0)                           AS wd_volume,
             coalesce(dep.dep_volume, 0) - coalesce(wdr.wd_volume, 0)
               - (coalesce(dep.bonus, 0) + coalesce(rec.bonus, 0)) AS ggr
        FROM ids i
        LEFT JOIN dep ON dep.company_id = i.company_id
        LEFT JOIN wdr ON wdr.company_id = i.company_id
        LEFT JOIN rec ON rec.company_id = i.company_id
        LEFT JOIN entities e ON e.entity_id = i.company_id
       ORDER BY ggr DESC`);

    const rows = res.rows as unknown as {
      dep_count: number;
      dep_volume: number;
      bonus: number;
      wd_count: number;
      wd_volume: number;
      ggr: number;
    }[];
    const add = (f: (r: (typeof rows)[number]) => number) =>
      rows.reduce((acc, r) => acc + Number(f(r)), 0);

    return Response.json({
      summary: {
        dep_count: add((r) => r.dep_count),
        dep_volume: add((r) => r.dep_volume),
        bonus: add((r) => r.bonus),
        wd_count: add((r) => r.wd_count),
        wd_volume: add((r) => r.wd_volume),
        ggr: add((r) => r.ggr),
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

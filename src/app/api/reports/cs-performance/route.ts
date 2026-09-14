import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import {
  all,
  businessDay,
  parseReportParams,
  scopeByPlayer,
  scopeDeposits,
  searchAcross,
} from "@/lib/report-sql";

/**
 * GET /api/reports/cs-performance — what each CS agent handled in the period.
 *
 * Only transactions with a handling agent are counted; the rest have nobody to
 * credit. One row per agent, so nothing to page — as with GGR, the fault was
 * the input, not the output: the browser was counting whatever slice of the
 * newest 500 deposits it happened to hold.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = parseReportParams(request.url);
    if ("error" in p) return jsonError(p.error);

    const dw: SQL[] = [...scopeDeposits(user), sql`d.handled_by_user_id IS NOT NULL`];
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

    const ww: SQL[] = [...scopeByPlayer(user), sql`wd.handled_by_user_id IS NOT NULL`];
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

    const res = await db.execute(sql`
      WITH dep AS (
        SELECT d.handled_by_user_id                        AS user_id,
               count(*)::int                               AS dep_count,
               coalesce(sum(d.total_amount), 0)::float8     AS dep_volume
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${all(dw)}
         GROUP BY 1
      ), wdr AS (
        SELECT wd.handled_by_user_id                        AS user_id,
               count(*)::int                                AS wd_count,
               coalesce(sum(wd.requested_amount), 0)::float8 AS wd_volume
          FROM withdrawals wd
          JOIN players pl ON pl.player_id = wd.player_id
         WHERE ${all(ww)}
         GROUP BY 1
      ), ids AS (
        SELECT user_id FROM dep UNION SELECT user_id FROM wdr
      )
      SELECT i.user_id,
             coalesce(u.full_name, '#' || i.user_id)  AS full_name,
             u.username,
             coalesce(dep.dep_count, 0)               AS dep_count,
             coalesce(dep.dep_volume, 0)              AS dep_volume,
             coalesce(wdr.wd_count, 0)                AS wd_count,
             coalesce(wdr.wd_volume, 0)               AS wd_volume,
             coalesce(dep.dep_count, 0) + coalesce(wdr.wd_count, 0)   AS txn_count,
             coalesce(dep.dep_volume, 0) + coalesce(wdr.wd_volume, 0) AS total_volume
        FROM ids i
        LEFT JOIN dep ON dep.user_id = i.user_id
        LEFT JOIN wdr ON wdr.user_id = i.user_id
        LEFT JOIN users u ON u.user_id = i.user_id
       ORDER BY total_volume DESC`);

    const rows = res.rows as unknown as {
      dep_count: number;
      dep_volume: number;
      wd_count: number;
      wd_volume: number;
    }[];
    const add = (f: (r: (typeof rows)[number]) => number) =>
      rows.reduce((acc, r) => acc + Number(f(r)), 0);

    return Response.json({
      summary: {
        agents: rows.length,
        dep_count: add((r) => r.dep_count),
        dep_volume: add((r) => r.dep_volume),
        wd_count: add((r) => r.wd_count),
        wd_volume: add((r) => r.wd_volume),
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

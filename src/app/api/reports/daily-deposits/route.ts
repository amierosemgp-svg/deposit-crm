import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import {
  all,
  businessDay,
  parseReportParams,
  scopeDepositsAsOf,
  searchAcross,
} from "@/lib/report-sql";

/**
 * GET /api/reports/daily-deposits — every deposit in the period, one page at a
 * time, with the period's totals alongside. See lib/report-sql.ts for why the
 * sums cannot be done in the browser.
 *
 * Query: from, to (YYYY-MM-DD, inclusive, Malaysian days), company, status, q,
 * limit, offset.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = parseReportParams(request.url);
    if ("error" in p) return jsonError(p.error);

    const w: SQL[] = [...scopeDepositsAsOf(user, sql`d.deposit_date`)];
    if (p.from) w.push(sql`${businessDay(sql`d.deposit_date`)} >= ${p.from}::date`);
    if (p.to) w.push(sql`${businessDay(sql`d.deposit_date`)} <= ${p.to}::date`);
    if (p.companyId !== null) w.push(sql`d.company_entity_id = ${p.companyId}`);
    if (p.status !== "all") w.push(sql`d.status::text = ${p.status}`);
    if (p.q) {
      w.push(
        searchAcross(
          sql`concat_ws(' ', d.transaction_ref, d.player_username, pl.full_name,
              pl.username, d.bank_name, d.bank_account_holder, d.bank_description,
              d.selected_game, d.game_topup_reference)`,
          p.q,
        ),
      );
    }
    const where = all(w);

    const [summaryRes, rowsRes] = await Promise.all([
      db.execute(sql`
        SELECT count(*)::int                                  AS count,
               count(DISTINCT d.player_id)::int               AS unique_players,
               coalesce(sum(d.deposit_amount), 0)::float8     AS amount,
               coalesce(sum(d.bonus_amount), 0)::float8       AS bonus,
               coalesce(sum(d.total_amount), 0)::float8       AS total
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${where}`),
      db.execute(sql`
        SELECT d.deposit_id, d.deposit_date, d.approved_at, d.transaction_ref,
               coalesce(pl.full_name, d.player_username, '—')  AS player,
               coalesce(e.name, '—')                           AS company,
               coalesce(d.selected_game, '—')                  AS game,
               d.status::text                                  AS status,
               coalesce(u.username, '—')                       AS agent,
               d.deposit_amount::float8                        AS deposit_amount,
               d.bonus_amount::float8                          AS bonus_amount,
               d.bonus_percentage::float8                      AS bonus_percentage,
               d.total_amount::float8                          AS total_amount
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
          LEFT JOIN entities e ON e.entity_id = d.company_entity_id
          LEFT JOIN users u ON u.user_id = d.handled_by_user_id
         WHERE ${where}
         ORDER BY d.deposit_date DESC, d.deposit_id DESC
         LIMIT ${p.limit} OFFSET ${p.offset}`),
    ]);

    const s = (summaryRes.rows[0] ?? {}) as Record<string, number>;
    return Response.json({
      summary: {
        count: s.count ?? 0,
        unique_players: s.unique_players ?? 0,
        amount: s.amount ?? 0,
        bonus: s.bonus ?? 0,
        total: s.total ?? 0,
      },
      rows: rowsRes.rows,
      total: s.count ?? 0,
      limit: p.limit,
      offset: p.offset,
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

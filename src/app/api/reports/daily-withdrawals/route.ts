import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import {
  all,
  businessDay,
  parseReportParams,
  scopeByPlayer,
  searchAcross,
} from "@/lib/report-sql";

/**
 * GET /api/reports/daily-withdrawals — every withdrawal in the period, paged,
 * with the period's totals. Scoped by the player's company, which is the only
 * company a withdrawal has.
 *
 * Query: from, to, company, status, q, limit, offset.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = parseReportParams(request.url);
    if ("error" in p) return jsonError(p.error);

    const w: SQL[] = [...scopeByPlayer(user)];
    if (p.from) w.push(sql`${businessDay(sql`wd.created_at`)} >= ${p.from}::date`);
    if (p.to) w.push(sql`${businessDay(sql`wd.created_at`)} <= ${p.to}::date`);
    if (p.companyId !== null) w.push(sql`pl.company_entity_id = ${p.companyId}`);
    if (p.status !== "all") w.push(sql`wd.status::text = ${p.status}`);
    if (p.q) {
      w.push(
        searchAcross(
          sql`concat_ws(' ', pl.full_name, pl.username, wd.game_name,
              wd.bank_name, wd.bank_account_number)`,
          p.q,
        ),
      );
    }
    const where = all(w);

    const [summaryRes, rowsRes] = await Promise.all([
      db.execute(sql`
        SELECT count(*)::int                                     AS count,
               count(DISTINCT wd.player_id)::int                 AS unique_players,
               coalesce(sum(wd.requested_amount), 0)::float8     AS requested,
               coalesce(sum(wd.credit_pulled_amount), 0)::float8 AS pulled
          FROM withdrawals wd
          JOIN players pl ON pl.player_id = wd.player_id
         WHERE ${where}`),
      db.execute(sql`
        SELECT wd.withdrawal_id, wd.created_at,
               coalesce(pl.full_name, pl.username)      AS player,
               coalesce(e.name, '—')                    AS company,
               wd.game_name,
               wd.bank_name, wd.bank_account_number,
               wd.status::text                          AS status,
               coalesce(u.username, '—')                AS agent,
               wd.requested_amount::float8              AS requested_amount,
               wd.credit_pulled_amount::float8          AS credit_pulled_amount
          FROM withdrawals wd
          JOIN players pl ON pl.player_id = wd.player_id
          LEFT JOIN entities e ON e.entity_id = pl.company_entity_id
          LEFT JOIN users u ON u.user_id = wd.handled_by_user_id
         WHERE ${where}
         ORDER BY wd.created_at DESC, wd.withdrawal_id DESC
         LIMIT ${p.limit} OFFSET ${p.offset}`),
    ]);

    const s = (summaryRes.rows[0] ?? {}) as Record<string, number>;
    return Response.json({
      summary: {
        count: s.count ?? 0,
        unique_players: s.unique_players ?? 0,
        requested: s.requested ?? 0,
        pulled: s.pulled ?? 0,
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

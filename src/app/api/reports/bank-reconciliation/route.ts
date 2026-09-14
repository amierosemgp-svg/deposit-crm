import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import {
  all,
  businessDay,
  parseReportParams,
  scopeDeposits,
  searchAcross,
} from "@/lib/report-sql";

/**
 * GET /api/reports/bank-reconciliation — deposits with the discrepancy flag
 * the report is for, paged, plus a count of flagged rows across the whole
 * period.
 *
 * The flag is computed in SQL rather than in the browser on purpose: the
 * headline is "how many discrepancies this month", and a count taken over one
 * page of a paged table answers a different question. It has to be derived
 * where every row is.
 */

/** Mirrors the flag the report has always shown, one branch per condition. */
const FLAG = sql`CASE
  WHEN d.status = 'failed'                                   THEN 'Failed'
  WHEN d.status = 'pending_match'                            THEN 'Unmatched'
  WHEN d.status = 'completed'
       AND coalesce(d.game_topup_reference, '') = ''         THEN 'No top-up ref'
  ELSE 'OK'
END`;

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = parseReportParams(request.url);
    if ("error" in p) return jsonError(p.error);

    const w: SQL[] = [...scopeDeposits(user)];
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
        SELECT count(*)::int                                        AS count,
               count(*) FILTER (WHERE ${FLAG} <> 'OK')::int         AS issues,
               coalesce(sum(d.deposit_amount), 0)::float8           AS amount
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${where}`),
      db.execute(sql`
        SELECT d.deposit_id, d.deposit_date, d.transaction_ref, d.bank_name,
               d.bank_account_holder,
               d.deposit_amount::float8   AS deposit_amount,
               d.status::text             AS status,
               d.game_topup_reference,
               ${FLAG}                    AS flag
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${where}
         ORDER BY d.deposit_date DESC, d.deposit_id DESC
         LIMIT ${p.limit} OFFSET ${p.offset}`),
    ]);

    const s = (summaryRes.rows[0] ?? {}) as Record<string, number>;
    return Response.json({
      summary: {
        count: s.count ?? 0,
        issues: s.issues ?? 0,
        amount: s.amount ?? 0,
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

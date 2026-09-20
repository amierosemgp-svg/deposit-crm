import { sql } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { businessDay, DATE_RE, IS_FREE_CREDIT } from "@/lib/report-sql";

/**
 * GET /api/players/win-loss — how each member has done against the house.
 *
 * The sign is the house's, matching every report: positive means the house is
 * up on that member, negative means the member is up. Reading it the other way
 * round would make the Players tab disagree with the Win/Loss report about the
 * same money.
 *
 *   in      deposits they paid in
 *   given   bonus on those deposits, plus free credit issued to them
 *   out     withdrawals paid to them
 *   net     in − given − out
 *
 * Query: from, to (YYYY-MM-DD, Malaysian days). Omit both for all time.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sp = new URL(request.url).searchParams;
    const from = sp.get("from");
    const to = sp.get("to");
    if (from && !DATE_RE.test(from)) return jsonError("Bad 'from' date");
    if (to && !DATE_RE.test(to)) return jsonError("Bad 'to' date");

    const scope =
      user.companyIds === null
        ? sql`true`
        : user.companyIds.length
          ? sql`p.company_entity_id IN (${sql.join(
              user.companyIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql`false`;

    // Built here rather than inline: an open-ended range needs the clause
    // dropped, not a NULL parameter, which Postgres cannot type (42P18).
    const within = (column: string) =>
      sql.join(
        [
          from ? sql`AND ${businessDay(sql.raw(column))} >= ${from}::date` : undefined,
          to ? sql`AND ${businessDay(sql.raw(column))} <= ${to}::date` : undefined,
        ].filter((x) => x !== undefined),
        sql` `,
      );

    const res = await db.execute(sql`
      WITH dep AS (
        SELECT d.player_id,
               coalesce(sum(d.deposit_amount), 0)::float8 AS money_in,
               coalesce(sum(d.bonus_amount), 0)::float8   AS bonus,
               count(*)::int                              AS deposit_count,
               max(d.deposit_date)                        AS last_deposit_at
          FROM deposits d
         WHERE d.status <> 'failed' AND d.player_id IS NOT NULL
               ${within("d.deposit_date")}
         GROUP BY 1
      ), wdr AS (
        SELECT wd.player_id,
               coalesce(sum(wd.credit_pulled_amount), 0)::float8 AS money_out,
               count(*)::int                                     AS withdrawal_count
          FROM withdrawals wd
         WHERE wd.status = 'paid'
               ${within("wd.created_at")}
         GROUP BY 1
      ), fc AS (
        SELECT t.player_id,
               coalesce(sum(t.amount), 0)::float8 AS free_credit
          FROM transactions t
         WHERE ${IS_FREE_CREDIT} AND t.player_id IS NOT NULL
               ${within("t.created_at")}
         GROUP BY 1
      ), rec AS (
        -- Paid to the upline, so it counts against whoever earned it.
        SELECT rb.upline_player_id AS player_id,
               coalesce(sum(rb.bonus_amount), 0)::float8 AS recommend
          FROM referral_bonuses rb
         WHERE rb.status = 'assigned'
               ${within("coalesce(rb.assigned_at, rb.created_at)")}
         GROUP BY 1
      )
      SELECT p.player_id,
             -- Carried on the row so the caller needs no roster to name it.
             p.username,
             p.full_name,
             p.company_entity_id,
             coalesce(dep.money_in, 0)         AS money_in,
             coalesce(dep.deposit_count, 0)    AS deposit_count,
             coalesce(dep.bonus, 0)            AS bonus,
             coalesce(fc.free_credit, 0)       AS free_credit,
             coalesce(rec.recommend, 0)        AS recommend,
             coalesce(wdr.money_out, 0)        AS money_out,
             coalesce(wdr.withdrawal_count, 0) AS withdrawal_count,
             dep.last_deposit_at,
             coalesce(dep.money_in, 0) - coalesce(dep.bonus, 0)
               - coalesce(fc.free_credit, 0) - coalesce(rec.recommend, 0)
               - coalesce(wdr.money_out, 0)    AS net
        FROM players p
        LEFT JOIN dep ON dep.player_id = p.player_id
        LEFT JOIN wdr ON wdr.player_id = p.player_id
        LEFT JOIN fc  ON fc.player_id  = p.player_id
        LEFT JOIN rec ON rec.player_id = p.player_id
       WHERE ${scope}
         -- A member who did nothing in the window has no win or loss to show.
         AND (dep.player_id IS NOT NULL OR wdr.player_id IS NOT NULL
              OR fc.player_id IS NOT NULL OR rec.player_id IS NOT NULL)`);

    return Response.json({ win_loss: res.rows });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

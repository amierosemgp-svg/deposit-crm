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
 * GET /api/reports/win-loss — where the month's result came from, per game.
 *
 * The daily and sales reports both end at one number: sales, what the house
 * kept. This one takes that number apart and files it by product, because the
 * two questions have different answers — a month can be up overall while one
 * kiosk bleeds, and nothing in a per-company view shows that.
 *
 *   in       deposits taken against the game
 *   given    bonus on those deposits, plus free credit issued into it
 *   out      withdrawals paid from it
 *   net      in − given − out
 *   margin   net as a share of in, which is the figure worth comparing
 *            between games of very different size
 *
 * Same arithmetic as the other two, so the totals reconcile across all three.
 */

/** Money that moved without a game named — still money, still counted. */
const NO_GAME = "(no game)";
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = parseReportParams(request.url);
    if ("error" in p) return jsonError(p.error);

    const dw: SQL[] = [
      ...scopeDepositsAsOf(user, sql`d.deposit_date`),
      DEPOSIT_COUNTS,
    ];
    if (p.from) dw.push(sql`${businessDay(sql`d.deposit_date`)} >= ${p.from}::date`);
    if (p.to) dw.push(sql`${businessDay(sql`d.deposit_date`)} <= ${p.to}::date`);
    if (p.companyId !== null) dw.push(sql`d.company_entity_id = ${p.companyId}`);

    const ww: SQL[] = [...scopeByPlayerAsOf(user, sql`wd.created_at`), WITHDRAWAL_COUNTS];
    if (p.from) ww.push(sql`${businessDay(sql`wd.created_at`)} >= ${p.from}::date`);
    if (p.to) ww.push(sql`${businessDay(sql`wd.created_at`)} <= ${p.to}::date`);
    if (p.companyId !== null) ww.push(sql`pl.company_entity_id = ${p.companyId}`);

    const fw: SQL[] = [IS_FREE_CREDIT];
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

    const res = await db.execute(sql`
      WITH dep AS (
        -- Deposits with no game chosen are still money in, and dropping them
        -- would leave this report disagreeing with the other two by exactly
        -- their value. They get a row of their own instead.
        SELECT coalesce(d.selected_game, ${NO_GAME})        AS game,
               coalesce(sum(d.deposit_amount), 0)::float8   AS money_in,
               coalesce(sum(d.bonus_amount), 0)::float8     AS bonus,
               count(*)::int                                AS deposit_count,
               count(DISTINCT d.player_id)::int             AS players
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${all(dw)}
         GROUP BY 1
      ), wdr AS (
        SELECT coalesce(wd.game_name, ${NO_GAME})                 AS game,
               coalesce(sum(wd.credit_pulled_amount), 0)::float8   AS money_out,
               count(*)::int                                       AS withdrawal_count
          FROM withdrawals wd
          JOIN players pl ON pl.player_id = wd.player_id
         WHERE ${all(ww)}
         GROUP BY 1
      ), fc AS (
        SELECT coalesce(t.game_name, ${NO_GAME})      AS game,
               coalesce(sum(t.amount), 0)::float8     AS free_credit
          FROM transactions t
         WHERE ${all(fw)}
         GROUP BY 1
      ), rec AS (
        SELECT coalesce(nullif(rb.game_name, ''), ${NO_GAME})  AS game,
               coalesce(sum(rb.bonus_amount), 0)::float8       AS recommend
          FROM referral_bonuses rb
          JOIN players up ON up.player_id = rb.upline_player_id
         WHERE ${all(rw)}
         GROUP BY 1
      ), games AS (
        SELECT game FROM dep
        UNION SELECT game FROM wdr
        UNION SELECT game FROM fc
        UNION SELECT game FROM rec
      )
      SELECT g.game,
             coalesce(dep.money_in, 0)          AS money_in,
             coalesce(dep.deposit_count, 0)     AS deposit_count,
             coalesce(dep.players, 0)           AS players,
             coalesce(dep.bonus, 0)             AS bonus,
             coalesce(fc.free_credit, 0)        AS free_credit,
             coalesce(wdr.money_out, 0)         AS money_out,
             coalesce(wdr.withdrawal_count, 0)  AS withdrawal_count,
             coalesce(rec.recommend, 0)         AS recommend,
             coalesce(dep.money_in, 0) - coalesce(dep.bonus, 0)
               - coalesce(rec.recommend, 0)
               - coalesce(fc.free_credit, 0) - coalesce(wdr.money_out, 0)  AS net,
             -- Margin on nothing is not 0%, it is undefined; null renders as a
             -- dash rather than as a game that broke exactly even.
             CASE WHEN coalesce(dep.money_in, 0) = 0 THEN NULL
                  ELSE round(((coalesce(dep.money_in, 0) - coalesce(dep.bonus, 0)
                       - coalesce(rec.recommend, 0)
                       - coalesce(fc.free_credit, 0) - coalesce(wdr.money_out, 0))
                       / coalesce(dep.money_in, 0) * 100)::numeric, 1)
             END                                                            AS margin
        FROM games g
        LEFT JOIN dep ON dep.game = g.game
        LEFT JOIN wdr ON wdr.game = g.game
        LEFT JOIN fc  ON fc.game  = g.game
        LEFT JOIN rec ON rec.game = g.game
       ORDER BY net DESC`);

    const rows = res.rows as unknown as Record<string, number>[];
    const add = (k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    const moneyIn = add("money_in");

    return Response.json({
      summary: {
        games: rows.length,
        money_in: moneyIn,
        bonus: add("bonus"),
        free_credit: add("free_credit"),
        recommend: add("recommend"),
        money_out: add("money_out"),
        net: add("net"),
        margin: moneyIn ? (add("net") / moneyIn) * 100 : 0,
        winning: rows.filter((r) => Number(r.net) > 0).length,
        losing: rows.filter((r) => Number(r.net) < 0).length,
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

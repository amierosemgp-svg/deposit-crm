import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import {
  IS_FREE_CREDIT,
  all,
  businessDay,
  parseReportParams,
  scopeByPlayerAsOf,
  scopeDepositsAsOf,
  searchAcross,
} from "@/lib/report-sql";

/**
 * GET /api/reports/bonus-payout — the Bonus Payout report, totalled in SQL.
 *
 * The reports pages were computed in the browser over the Zustand store, and
 * the store holds the newest 500 deposits (see /api/state). Any month bigger
 * than that reported whatever fraction happened to be loaded: an imported
 * month of 9,037 deposits showed RM 12,526 of a real RM 69,164. The number is
 * an aggregate over the whole period, so no amount of paging fixes it on the
 * client — the sum has to happen where all the rows are.
 *
 * Two shapes, chosen by whether `game` is set:
 *   without  → the summary cards and one row per game (level 1)
 *   with     → the summary scoped to that game, plus its payouts, paged (level 2)
 *
 * Both come back with the summary attached, computed from the same filtered
 * set as the rows, so a card can never disagree with the table beneath it.
 *
 * Query: from, to (YYYY-MM-DD, inclusive, Malaysian calendar days), company
 * (id or "all"), type (all|Deposit|Recommend), status (deposit status or
 * "all"), q (free text), game, limit, offset.
 */

/** A recommend bonus CS has not credited yet has no game to file it under. */
const NO_GAME = "(no game yet)";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = parseReportParams(request.url);
    if ("error" in p) return jsonError(p.error);
    const { from, to, companyId, status, q, limit, offset } = p;
    const type = new URL(request.url).searchParams.get("type") ?? "all";
    const game = new URL(request.url).searchParams.get("game");

    // Which parts of the union to build. Mirrors the client exactly: a chosen
    // deposit status can never be satisfied by a recommend bonus or a free
    // credit, so picking one hides them — unless the view is already narrowed
    // to that kind, where the status filter simply does not apply rather than
    // emptying the table.
    const wantDeposits = type === "all" || type === "Deposit";
    const wantRecommend =
      (type === "all" && status === "all") || type === "Recommend";
    const wantFreeCredit =
      (type === "all" && status === "all") || type === "Free Credit";

    const branches: SQL[] = [];

    if (wantDeposits) {
      const w: SQL[] = [
        // Non-zero, not positive: a clawback is part of what was paid out.
        sql`d.bonus_amount <> 0`,
        ...scopeDepositsAsOf(user, sql`d.deposit_date`),
      ];
      if (from) w.push(sql`${businessDay(sql`d.deposit_date`)} >= ${from}::date`);
      if (to) w.push(sql`${businessDay(sql`d.deposit_date`)} <= ${to}::date`);
      if (companyId !== null) w.push(sql`d.company_entity_id = ${companyId}`);
      if (status !== "all") w.push(sql`d.status::text = ${status}`);
      if (q) {
        w.push(
          searchAcross(
            sql`concat_ws(' ', d.transaction_ref, d.player_username, pl.full_name,
                pl.username, d.bank_name, d.bank_account_holder, d.bank_description,
                d.selected_game, d.game_topup_reference)`,
            q,
          ),
        );
      }
      if (game !== null) {
        w.push(sql`coalesce(nullif(d.selected_game, ''), ${NO_GAME}) = ${game}`);
      }
      branches.push(sql`
        SELECT 'Deposit'::text                                     AS kind,
               'dep-' || d.deposit_id                              AS key,
               d.deposit_date                                      AS at,
               d.transaction_ref                                   AS ref,
               d.player_id                                         AS player_id,
               coalesce(pl.full_name, d.player_username, '—')      AS player,
               d.company_entity_id                                 AS company_id,
               coalesce(nullif(d.selected_game, ''), ${NO_GAME})   AS game,
               d.status::text                                      AS status,
               d.bonus_percentage                                  AS pct,
               d.deposit_amount                                    AS basis,
               d.bonus_amount                                      AS bonus
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${all(w)}`);
    }

    if (wantRecommend) {
      // The upline is the one paid, so the row is theirs: their name, their
      // company. The downline only appears in the search text.
      const at = sql`coalesce(rb.assigned_at, rb.created_at)`;
      const w: SQL[] = [
        sql`rb.status <> 'cancelled'`,
        ...scopeByPlayerAsOf(user, at, "up"),
      ];
      if (from) w.push(sql`${businessDay(at)} >= ${from}::date`);
      if (to) w.push(sql`${businessDay(at)} <= ${to}::date`);
      if (companyId !== null) w.push(sql`up.company_entity_id = ${companyId}`);
      if (q) {
        w.push(
          searchAcross(
            sql`concat_ws(' ', 'rec-' || rb.bonus_id, up.full_name, up.username,
                dn.full_name, dn.username, rb.game_name, rb.note)`,
            q,
          ),
        );
      }
      if (game !== null) {
        w.push(sql`coalesce(nullif(rb.game_name, ''), ${NO_GAME}) = ${game}`);
      }
      branches.push(sql`
        SELECT 'Recommend'::text                                   AS kind,
               'rec-' || rb.bonus_id                               AS key,
               ${at}                                               AS at,
               'REC-' || rb.bonus_id                               AS ref,
               rb.upline_player_id                                 AS player_id,
               coalesce(up.full_name, up.username)                 AS player,
               up.company_entity_id                                AS company_id,
               coalesce(nullif(rb.game_name, ''), ${NO_GAME})      AS game,
               rb.status::text                                     AS status,
               rb.bonus_percentage                                 AS pct,
               rb.deposit_amount                                   AS basis,
               rb.bonus_amount                                     AS bonus
          FROM referral_bonuses rb
          JOIN players up ON up.player_id = rb.upline_player_id
          LEFT JOIN players dn ON dn.player_id = rb.downline_player_id
         WHERE ${all(w)}`);
    }

    if (wantFreeCredit) {
      /**
       * Credit given with no deposit behind it — a rebate, a goodwill credit,
       * a promo. Money out of the house exactly as a bonus is, and left out of
       * this report it simply went unreported: RM 16,559 of it in RajaClub's
       * first imported month alone.
       *
       * It has no table of its own. A free credit IS the game_topup ledger row
       * issueFreeCredit writes, which is why this branch reads transactions.
       */
      const w: SQL[] = [
        IS_FREE_CREDIT,
        ...(user.ownedEntityIds === null
          ? []
          : [
              sql`t.entity_id IN (${sql.join(
                user.ownedEntityIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            ]),
      ];
      if (from) w.push(sql`${businessDay(sql`t.created_at`)} >= ${from}::date`);
      if (to) w.push(sql`${businessDay(sql`t.created_at`)} <= ${to}::date`);
      if (companyId !== null) w.push(sql`t.entity_id = ${companyId}`);
      if (q) {
        w.push(
          searchAcross(
            sql`concat_ws(' ', 'fc-' || t.transaction_id, fp.full_name, fp.username,
                t.game_name, t.details->>'remark')`,
            q,
          ),
        );
      }
      if (game !== null) {
        w.push(sql`coalesce(nullif(t.game_name, ''), ${NO_GAME}) = ${game}`);
      }
      branches.push(sql`
        SELECT 'Free Credit'::text                                 AS kind,
               'fc-' || t.transaction_id                           AS key,
               t.created_at                                        AS at,
               'FC-' || t.transaction_id                           AS ref,
               t.player_id                                         AS player_id,
               coalesce(fp.full_name, fp.username, '—')            AS player,
               t.entity_id                                         AS company_id,
               coalesce(nullif(t.game_name, ''), ${NO_GAME})       AS game,
               -- Issued the moment it is recorded; there is no pending state
               -- to show, and no percentage or basis behind it.
               'completed'::text                                   AS status,
               0::numeric                                          AS pct,
               0::numeric                                          AS basis,
               t.amount                                            AS bonus
          FROM transactions t
          LEFT JOIN players fp ON fp.player_id = t.player_id
         WHERE ${all(w)}`);
    }

    // Nothing wanted is a legitimate, empty answer — not an error.
    if (!branches.length) {
      return Response.json({
        summary: EMPTY_SUMMARY,
        games: [],
        rows: [],
        total: 0,
        limit,
        offset,
      });
    }

    const payout = sql`WITH payout AS (${sql.join(branches, sql` UNION ALL `)})`;

    const summaryQuery = db.execute(sql`
      ${payout}
      SELECT
        coalesce(sum(bonus) FILTER (WHERE kind = 'Deposit'), 0)::float8   AS deposit_bonus,
        coalesce(sum(bonus) FILTER (WHERE kind = 'Recommend'), 0)::float8 AS recommend_bonus,
        coalesce(sum(bonus) FILTER (WHERE kind = 'Free Credit'), 0)::float8 AS free_credit,
        coalesce(sum(basis), 0)::float8                                   AS basis,
        count(*) FILTER (WHERE kind = 'Deposit')::int                     AS deposit_count,
        count(*) FILTER (WHERE kind = 'Recommend')::int                   AS recommend_count,
        count(*) FILTER (WHERE kind = 'Free Credit')::int                  AS free_credit_count,
        count(DISTINCT player_id)::int                                    AS unique_players
      FROM payout`);

    // Level 1 wants the per-game rollup and no rows; level 2 the reverse.
    const gamesQuery = game
      ? Promise.resolve({ rows: [] as Record<string, unknown>[] })
      : db.execute(sql`
          ${payout}
          SELECT game,
                 count(*)::int                                         AS payouts,
                 count(*) FILTER (WHERE kind = 'Deposit')::int         AS deposit_count,
                 count(*) FILTER (WHERE kind = 'Recommend')::int       AS recommend_count,
                 count(*) FILTER (WHERE kind = 'Free Credit')::int     AS free_credit_count,
                 coalesce(sum(basis), 0)::float8                       AS basis,
                 coalesce(sum(bonus), 0)::float8                       AS bonus
            FROM payout
           GROUP BY game
           ORDER BY bonus DESC`);

    const rowsQuery = game
      ? db.execute(sql`
          ${payout}
          SELECT p.key, p.kind, p.at, p.ref, p.player_id, p.player,
                 coalesce(e.name, '—') AS company,
                 p.game, p.status, p.pct::float8 AS pct,
                 p.basis::float8 AS basis, p.bonus::float8 AS bonus
            FROM payout p
            LEFT JOIN entities e ON e.entity_id = p.company_id
           ORDER BY p.at DESC, p.key
           LIMIT ${limit} OFFSET ${offset}`)
      : Promise.resolve({ rows: [] as Record<string, unknown>[] });

    const [summaryRes, gamesRes, rowsRes] = await Promise.all([
      summaryQuery,
      gamesQuery,
      rowsQuery,
    ]);

    const s = (summaryRes.rows[0] ?? {}) as Record<string, number>;
    const summary = {
      deposit_bonus: s.deposit_bonus ?? 0,
      recommend_bonus: s.recommend_bonus ?? 0,
      free_credit: s.free_credit ?? 0,
      free_credit_count: s.free_credit_count ?? 0,
      basis: s.basis ?? 0,
      deposit_count: s.deposit_count ?? 0,
      recommend_count: s.recommend_count ?? 0,
      unique_players: s.unique_players ?? 0,
    };

    return Response.json({
      summary,
      games: gamesRes.rows,
      rows: rowsRes.rows,
      // What the drill holds in total, so the pager knows where it ends.
      total:
        summary.deposit_count +
        summary.recommend_count +
        summary.free_credit_count,
      limit,
      offset,
    });
  } catch (e) {
    return (
      authErrorResponse(e) ??
      (console.error(e), jsonError("Server error", 500))
    );
  }
}

const EMPTY_SUMMARY = {
  deposit_bonus: 0,
  recommend_bonus: 0,
  free_credit: 0,
  free_credit_count: 0,
  basis: 0,
  deposit_count: 0,
  recommend_count: 0,
  unique_players: 0,
};

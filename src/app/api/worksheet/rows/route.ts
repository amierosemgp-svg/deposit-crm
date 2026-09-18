import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError, visibleEntityIds } from "@/lib/api-helpers";
import {
  all,
  businessDay,
  csCutoff,
  DEPOSIT_COUNTS,
  parseReportParams,
  scopeDeposits,
  scopeByPlayer,
  WITHDRAWAL_COUNTS,
} from "@/lib/report-sql";

/**
 * GET /api/worksheet/rows?sheet=deposit|withdrawal&from=&to=&limit=&offset=
 *
 * The worksheet's own rows, for the range it is showing.
 *
 * /api/state carries a fixed slice — the newest 500 deposits — because it is one
 * payload polled every ten seconds by every open tab. At ~120 deposits a day
 * that slice reached back four days, so opening the month showed a fortnight of
 * nothing: 1,970 of Pokercity's 2,593 rows were in the database and never sent.
 * The cap also tightens as the house grows busier, which is the wrong direction.
 *
 * So the sheet asks for what it is displaying instead. Same shape as the reports:
 * a page of rows plus the totals for the *whole* range, so the figures above the
 * sheet describe the period rather than the page.
 */

/**
 * A row as the client's types expect it.
 *
 * `db.execute` returns raw pg rows, and pg hands back `numeric` as a *string* —
 * "50.00", not 50. The sheet formats and sums these, so every amount would read
 * as text and every total as NaN. to_jsonb keeps the whole row without naming
 * thirty columns, and the merge re-types just the money.
 */
const asRow = (table: string, numerics: string[]) =>
  sql.raw(
    `to_jsonb(${table}) || jsonb_build_object(${numerics
      .map((c) => `'${c}', ${table}.${c}::float8`)
      .join(", ")}) AS row`,
  );

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = parseReportParams(request.url);
    if ("error" in p) return jsonError(p.error);

    const sp = new URL(request.url).searchParams;
    const sheet = sp.get("sheet") ?? "deposit";
    const SHEETS = [
      "deposit",
      "withdrawal",
      "transfer",
      "freecredit",
      "leaderwithdrawal",
      "leadertransfer",
      "expense",
    ] as const;
    if (!(SHEETS as readonly string[]).includes(sheet)) {
      return jsonError(`sheet must be one of ${SHEETS.join(", ")}`);
    }
    // Generous, because a sheet is meant to be scrolled; still bounded, so one
    // request cannot ask for a year of a busy house in one go.
    const limit = Math.min(Number(sp.get("limit") ?? 2000) || 2000, 5000);
    const offset = Math.max(Number(sp.get("offset") ?? 0) || 0, 0);

    /**
     * A CS agent sees a rolling day, whatever range they ask for.
     *
     * The sheet's date filter is theirs to move, and without this a CS could
     * simply widen it and read the month — the row cap that used to hide older
     * rows was never the rule, just a side effect of the payload size. The same
     * 24 hours /api/state has always applied, now enforced where the rows are.
     */
    const cutoff = csCutoff(user);
    const visible = await visibleEntityIds(user);

    if (sheet === "deposit") {
      const w = [...scopeDeposits(user), DEPOSIT_COUNTS];
      if (p.from) w.push(sql`${businessDay(sql`d.deposit_date`)} >= ${p.from}::date`);
      if (p.to) w.push(sql`${businessDay(sql`d.deposit_date`)} <= ${p.to}::date`);
      if (p.companyId !== null) w.push(sql`d.company_entity_id = ${p.companyId}`);
      if (cutoff) w.push(sql`d.created_at >= ${cutoff}::timestamptz`);

      const rows = await db.execute(sql`
        SELECT ${asRow("d", [
          "deposit_amount",
          "bonus_amount",
          "bonus_percentage",
          "bonus_basis_amount",
          "total_amount",
        ])}
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${all(w)}
         ORDER BY d.deposit_date DESC, d.deposit_id DESC
         LIMIT ${limit} OFFSET ${offset}`);

      const [totals] = (await db.execute(sql`
        SELECT count(*)::int AS rows,
               coalesce(sum(d.deposit_amount), 0)::float8 AS amount,
               coalesce(sum(d.bonus_amount), 0)::float8   AS bonus
          FROM deposits d
          LEFT JOIN players pl ON pl.player_id = d.player_id
         WHERE ${all(w)}`)).rows as unknown as Record<string, number>[];

      return Response.json({
        rows: rows.rows.map((r) => (r as { row: unknown }).row),
        totals,
        limit,
        offset,
      });
    }

    const w = [...scopeByPlayer(user), WITHDRAWAL_COUNTS];
    if (p.from) w.push(sql`${businessDay(sql`wd.created_at`)} >= ${p.from}::date`);
    if (p.to) w.push(sql`${businessDay(sql`wd.created_at`)} <= ${p.to}::date`);
    if (p.companyId !== null) w.push(sql`pl.company_entity_id = ${p.companyId}`);
    if (cutoff) w.push(sql`wd.created_at >= ${cutoff}::timestamptz`);

    const rows = await db.execute(sql`
      SELECT ${asRow("wd", ["requested_amount", "credit_pulled_amount"])}
        FROM withdrawals wd
        JOIN players pl ON pl.player_id = wd.player_id
       WHERE ${all(w)}
       ORDER BY wd.created_at DESC, wd.withdrawal_id DESC
       LIMIT ${limit} OFFSET ${offset}`);

    const [totals] = (await db.execute(sql`
      SELECT count(*)::int AS rows,
             coalesce(sum(wd.credit_pulled_amount), 0)::float8 AS amount
        FROM withdrawals wd
        JOIN players pl ON pl.player_id = wd.player_id
       WHERE ${all(w)}`)).rows as unknown as Record<string, number>[];

    if (sheet === "withdrawal") {
      return Response.json({
        rows: rows.rows.map((r) => (r as { row: unknown }).row),
        totals,
        limit,
        offset,
      });
    }

    /**
     * The rest of the sheets.
     *
     * Each was reading a fixed slice of its own — game transfers were capped at
     * 200 rows inside /api/state, expenses at 500 — so the same blind spot
     * existed on every tab, just at a different depth. They are scoped through
     * the player or the entity as the reports scope them, and windowed on the
     * column the sheet sorts by.
     */
    const company = user.companyIds;
    const inCompanies = (col: SQL) =>
      company === null
        ? sql`true`
        : company.length
          ? sql`${col} IN (${sql.join(company.map((id) => sql`${id}`), sql`, `)})`
          : sql`false`;

    const spec: Record<string, { from: SQL; scope: SQL; date: SQL; numerics: string[]; alias: string }> = {
      transfer: {
        from: sql`game_transfers t JOIN players pl ON pl.player_id = t.player_id`,
        scope: inCompanies(sql`pl.company_entity_id`),
        date: sql`t.created_at`,
        numerics: ["transfer_amount", "from_game_balance_before"],
        alias: "t",
      },
      freecredit: {
        from: sql`transactions t`,
        scope: sql`t.type = 'game_topup' AND t.details->>'action' = 'free_credit' AND ${inCompanies(sql`t.entity_id`)}`,
        date: sql`t.created_at`,
        numerics: ["amount"],
        alias: "t",
      },
      leaderwithdrawal: {
        from: sql`bank_cash_outs t`,
        scope: inCompanies(sql`t.entity_id`),
        date: sql`t.occurred_at`,
        numerics: ["amount"],
        alias: "t",
      },
      leadertransfer: {
        from: sql`leader_transfers t`,
        // One end in the caller's tree. The sheet is open to the desk now, and
        // an unscoped ledger would show them every organisation's settlements.
        scope: visible === null
          ? sql`true`
          : visible.length
            ? sql`(t.from_leader_entity_id IN (${sql.join(visible.map((id) => sql`${id}`), sql`, `)})
                   OR t.to_leader_entity_id IN (${sql.join(visible.map((id) => sql`${id}`), sql`, `)}))`
            : sql`false`,
        date: sql`t.created_at`,
        numerics: ["amount"],
        alias: "t",
      },
      expense: {
        from: sql`expenses t`,
        scope: inCompanies(sql`t.company_entity_id`),
        date: sql`t.expense_date`,
        numerics: ["amount"],
        alias: "t",
      },
    };

    const cfg = spec[sheet];
    const where: SQL[] = [cfg.scope];
    if (cutoff) where.push(sql`${cfg.date} >= ${cutoff}::timestamptz`);
    if (p.from) where.push(sql`${businessDay(cfg.date)} >= ${p.from}::date`);
    if (p.to) where.push(sql`${businessDay(cfg.date)} <= ${p.to}::date`);

    // The Free Credit sheet reads a flattened row — reason, source and the
    // transfer it queued — which live inside `details` on the ledger. Raw rows
    // left every one of them undefined, and a free credit with no source reads
    // as "queued for the agent".
    const shape =
      sheet === "freecredit"
        ? sql`jsonb_build_object(
              'transaction_id', t.transaction_id, 'created_at', t.created_at,
              'player_id', t.player_id, 'entity_id', t.entity_id,
              'game_name', t.game_name, 'amount', t.amount::float8,
              'user_id', t.user_id,
              'reason', t.details->>'reason',
              'source', coalesce(t.details->>'source', 'manual'),
              'game_transfer_id', (t.details->>'game_transfer_id')::int) AS row`
        : asRow(cfg.alias, cfg.numerics);

    const other = await db.execute(sql`
      SELECT ${shape}
        FROM ${cfg.from}
       WHERE ${all(where)}
       ORDER BY ${cfg.date} DESC
       LIMIT ${limit} OFFSET ${offset}`);
    const [otherTotals] = (await db.execute(sql`
      SELECT count(*)::int AS rows,
             coalesce(sum(${sql.raw(`${cfg.alias}.${cfg.numerics[0]}`)}), 0)::float8 AS amount
        FROM ${cfg.from}
       WHERE ${all(where)}`)).rows as unknown as Record<string, number>[];

    return Response.json({
      rows: other.rows.map((r) => (r as { row: unknown }).row),
      totals: otherTotals,
      limit,
      offset,
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

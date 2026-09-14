import { sql, type SQL } from "drizzle-orm";
import type { AuthedUser } from "@/lib/auth";

/**
 * Shared plumbing for the server-side report endpoints.
 *
 * Every report used to be totalled in the browser over the Zustand store, and
 * the store holds only the newest few hundred rows of each table (see
 * /api/state). Any period bigger than that reported whatever fraction happened
 * to be loaded — an imported month of 9,037 deposits showed a sixth of itself.
 * A report's headline is an aggregate over the whole period, so no amount of
 * paging fixes it on the client; the sums have to happen where all the rows
 * are. These are the pieces each report's route composes to do that.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Rows per page for the reports that list transactions rather than roll up. */
export const REPORT_PAGE_SIZE = 100;

/** The cap on one request, so an "export everything" loop stays chunked. */
export const REPORT_MAX_LIMIT = 500;

/**
 * The business day, everywhere.
 *
 * Timestamps are stored UTC and production runs UTC, so `at::date` would cut
 * the day at 08:00 Malaysian time and file eight hours of every evening under
 * the wrong date. The browser bucketed these in its own zone (lib/date-range.ts)
 * and got it right by being physically in Malaysia; the server has to say so.
 */
export const BUSINESS_TZ = "Asia/Kuala_Lumpur";

export const businessDay = (column: SQL) =>
  sql`(${column} AT TIME ZONE ${BUSINESS_TZ})::date`;

/** AND a list of conditions; an empty list matches everything. */
export const all = (parts: SQL[]) =>
  parts.length ? sql.join(parts, sql` AND `) : sql`true`;

/** `col IN (…)` from a number list, which drizzle's sql`` will not do alone. */
export const inList = (column: SQL, ids: number[]) =>
  sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;

export type ReportParams = {
  from: string | null;
  to: string | null;
  companyId: number | null;
  status: string;
  q: string;
  limit: number;
  offset: number;
};

/**
 * The filter bar, parsed. Returns a string instead of params when something is
 * malformed, so the route can answer 400 rather than quietly widen the query.
 */
export function parseReportParams(
  url: string,
): ReportParams | { error: string } {
  const sp = new URL(url).searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const company = sp.get("company");

  if (from && !DATE_RE.test(from)) return { error: "Bad 'from' date" };
  if (to && !DATE_RE.test(to)) return { error: "Bad 'to' date" };

  let companyId: number | null = null;
  if (company && company !== "all") {
    companyId = Number(company);
    if (!Number.isInteger(companyId)) return { error: "Bad 'company'" };
  }

  return {
    from,
    to,
    companyId,
    status: sp.get("status") ?? "all",
    q: (sp.get("q") ?? "").trim().toLowerCase(),
    limit: Math.min(
      Math.max(Number(sp.get("limit")) || REPORT_PAGE_SIZE, 1),
      REPORT_MAX_LIMIT,
    ),
    offset: Math.max(Number(sp.get("offset")) || 0, 0),
  };
}

/** A case-insensitive contains, over several columns joined with spaces. */
export const searchAcross = (columns: SQL, q: string) =>
  sql`lower(${columns}) LIKE ${"%" + q + "%"}`;

/**
 * The deposits this user may see. Mirrors depositScopeFilter (api-helpers) for
 * raw SQL, where the drizzle query builder is not in play. `d` is the alias.
 */
export function scopeDeposits(user: AuthedUser, alias = "d"): SQL[] {
  if (user.companyIds === null) return [];
  const col = sql.raw(`${alias}.company_entity_id`);
  if (!user.companyIds.length) return [sql`${col} IS NULL`];
  return [sql`(${inList(col, user.companyIds)} OR ${col} IS NULL)`];
}

/**
 * Rows owned by a player, scoped by that player's company — withdrawals,
 * recommend bonuses. `alias` is the *players* alias in the query.
 */
export function scopeByPlayer(user: AuthedUser, alias = "pl"): SQL[] {
  if (user.companyIds === null) return [];
  const col = sql.raw(`${alias}.company_entity_id`);
  if (!user.companyIds.length) return [sql`false`];
  return [inList(col, user.companyIds)];
}

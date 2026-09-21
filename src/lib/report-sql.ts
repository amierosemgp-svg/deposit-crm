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
/**
 * How far back a CS agent may look: a rolling 24 hours.
 *
 * They work the day in front of them, and everything they need to act on — a
 * pending deposit, a withdrawal waiting to be paid — happened within it. The
 * rest is the desk's history, which is a leader's to read.
 *
 * Returned as an ISO instant rather than a business day, so the window rolls
 * with the clock instead of snapping to midnight and emptying the sheet at the
 * start of a shift.
 */
export function csCutoff(user: AuthedUser): string | null {
  return user.role === "cs_agent"
    ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    : null;
}

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

/** Every company a leader holds; falls back to the one they sit on. */
const leaderEntitiesOf = (user: AuthedUser): number[] =>
  user.leaderEntityIds?.length ? user.leaderEntityIds : [user.entity_id];

/**
 * A leader's scope, resolved at each row's own date.
 *
 * Operational screens ask "what can I act on now", and current ownership is
 * the right answer. A report asks something else: what was mine *then*. Since
 * a company can change leaders, the two diverge the moment anything is
 * restructured — and scoping a report by today's ownership would hand a leader
 * last month's figures for a company they had not yet taken on, while hiding
 * the ones they ran and have since passed along.
 *
 * `dateColumn` is the row's own timestamp, so every row is judged against the
 * ownership in force when it happened. Nothing else can make a settlement
 * already paid keep matching the report that justified it.
 */
function leaderOwnedAt(
  leaderEntityIds: number[],
  companyColumn: SQL,
  dateColumn: SQL,
): SQL {
  // A leader may hold several companies (see leader_memberships), so the test
  // is "any of theirs owned it then", not "that one did".
  if (!leaderEntityIds.length) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM company_leaders cl
     WHERE cl.company_entity_id = ${companyColumn}
       AND cl.leader_entity_id IN (${sql.join(
         leaderEntityIds.map((id) => sql`${id}`),
         sql`, `,
       )})
       AND cl.valid_from <= ${dateColumn}
       AND (cl.valid_to IS NULL OR cl.valid_to > ${dateColumn})
  )`;
}

/**
 * The deposits this user may see in a *report*, judged per row.
 *
 * Same shape as scopeDeposits for everyone who is not a leader; a leader gets
 * the as-of test above instead of a flat company list.
 */
export function scopeDepositsAsOf(
  user: AuthedUser,
  dateColumn: SQL,
  alias = "d",
): SQL[] {
  const col = sql.raw(`${alias}.company_entity_id`);
  if (user.role === "company_leader") {
    return [leaderOwnedAt(leaderEntitiesOf(user), col, dateColumn)];
  }
  return scopeDeposits(user, alias);
}

/** As scopeByPlayer, judged at the row's own date for a leader. */
export function scopeByPlayerAsOf(
  user: AuthedUser,
  dateColumn: SQL,
  alias = "pl",
): SQL[] {
  const col = sql.raw(`${alias}.company_entity_id`);
  if (user.role === "company_leader") {
    return [leaderOwnedAt(leaderEntitiesOf(user), col, dateColumn)];
  }
  return scopeByPlayer(user, alias);
}

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

/**
 * The operating figures the house actually runs on, as their own worksheet
 * defines them (Daily Report All Company).
 *
 *   total deposit  money taken in that day
 *   AP             active players — distinct members who deposited
 *   NP             new players — members whose FIRST deposit was that day
 *   sales          what the house kept: deposits − withdrawals − everything
 *                  given away. Their sheet carries it cumulatively through the
 *                  month with the daily delta beside it; both are derived from
 *                  this one figure.
 *
 * Defined once here because three reports read them and a house that cannot
 * reconcile its own daily report against its sales report has two numbers and
 * no answer.
 */

/**
 * Deposits that count as money in.
 *
 * Every status except failed. A deposit sitting in "processing" has already
 * been paid into the bank — that is what makes it a deposit — and excluding it
 * would under-report the day CS entered it and over-report the day they got
 * round to completing it.
 */
export const DEPOSIT_COUNTS = sql`d.status <> 'failed'`;

/** Withdrawals that count as money out: only what was actually paid. */
export const WITHDRAWAL_COUNTS = sql`wd.status = 'paid'`;

/** The MYT calendar day a row belongs to, as a date. */
export const dayOf = (column: SQL) => businessDay(column);

/**
 * When a recommend bonus counts: when it was handed over, falling back to when
 * it was earned for one still waiting on CS. Shared so every report files it
 * on the same day.
 */
export const RB_AT = sql`coalesce(rb.assigned_at, rb.created_at)`;

/**
 * A free-credit ledger row.
 *
 * `action` rather than `kind`: issueFreeCredit has always written `action`,
 * and only the RajaClub import added a `kind` alongside it. Filtering on the
 * latter silently counted the imported month and none of the credits CS has
 * issued since — the reports agreed with each other and with nothing else.
 *
 * Paired with the row type, since `action` is a free-text marker and only
 * `game_topup` rows carry this one.
 */
export const IS_FREE_CREDIT = sql`t.type = 'game_topup' AND t.details->>'action' = 'free_credit'`;

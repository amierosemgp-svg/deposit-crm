import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bonusPlans,
  deposits,
  gameTransfers,
  players,
  rebatePayouts,
  settings,
  withdrawals,
} from "@/db/schema";
import { BUSINESS_UTC_OFFSET_MS } from "@/lib/bonus";
import { AuthError, type AuthedUser } from "@/lib/auth";
import type { BonusPeriod, BonusPlan } from "@/lib/types";

/**
 * Rebates, paid from a list rather than on a deposit.
 *
 * A rebate plan pays a share of what a player lost over a window: completed
 * deposits minus paid withdrawals between two cutoffs. The cutoffs are the
 * business's own reset times — "daily at 06:00", "weekly on Monday 00:00",
 * "monthly on the 1st" — kept in settings under `rebate_cutoffs`, so the
 * window is whatever the company calls a day, week or month, not the calendar's.
 *
 * "Generate" snapshots the latest closed window into `rebate_payouts`; each
 * row is then paid as a free credit to the player's game. The snapshot is
 * what protects a payout from a late withdrawal quietly changing the figure.
 */

// ---- cutoffs ---------------------------------------------------------------

export type RebateCutoffs = {
  /** "HH:MM" in business time. */
  daily: { time: string };
  /** 0 = Sunday … 6 = Saturday. */
  weekly: { weekday: number; time: string };
  /** 1–31; a day past the month's end clamps to its last day. */
  monthly: { day: number; time: string };
};

export const REBATE_CUTOFFS_KEY = "rebate_cutoffs";

export const DEFAULT_REBATE_CUTOFFS: RebateCutoffs = {
  daily: { time: "00:00" },
  weekly: { weekday: 1, time: "00:00" },
  monthly: { day: 1, time: "00:00" },
};

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function cleanTime(raw: unknown, fallback: string): string {
  return typeof raw === "string" && TIME_RE.test(raw.trim()) ? raw.trim() : fallback;
}

/** Tolerant read of the stored setting — anything missing falls back. */
export function parseRebateCutoffs(raw: unknown): RebateCutoffs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const daily = (r.daily ?? {}) as Record<string, unknown>;
  const weekly = (r.weekly ?? {}) as Record<string, unknown>;
  const monthly = (r.monthly ?? {}) as Record<string, unknown>;
  const weekday = Number(weekly.weekday);
  const day = Number(monthly.day);
  return {
    daily: { time: cleanTime(daily.time, DEFAULT_REBATE_CUTOFFS.daily.time) },
    weekly: {
      weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
        ? weekday
        : DEFAULT_REBATE_CUTOFFS.weekly.weekday,
      time: cleanTime(weekly.time, DEFAULT_REBATE_CUTOFFS.weekly.time),
    },
    monthly: {
      day: Number.isInteger(day) && day >= 1 && day <= 31 ? day : DEFAULT_REBATE_CUTOFFS.monthly.day,
      time: cleanTime(monthly.time, DEFAULT_REBATE_CUTOFFS.monthly.time),
    },
  };
}

export async function loadRebateCutoffs(): Promise<RebateCutoffs> {
  const [row] = await db.select().from(settings).where(eq(settings.key, REBATE_CUTOFFS_KEY));
  return parseRebateCutoffs(row?.value);
}

export const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

/** "daily at 06:00" / "weekly, Monday 00:00" / "monthly, day 1 at 00:00". */
export function describeCutoff(period: BonusPeriod, c: RebateCutoffs): string {
  if (period === "daily") return `daily at ${c.daily.time}`;
  if (period === "weekly") return `weekly, ${WEEKDAY_NAMES[c.weekly.weekday]} ${c.weekly.time}`;
  return `monthly, day ${c.monthly.day} at ${c.monthly.time}`;
}

// ---- window arithmetic (business time) ------------------------------------

// Shift into business time so UTC getters/setters read as local ones, do the
// calendar work there, then shift back — the same trick bonus.ts uses.
const toLocal = (d: Date) => new Date(d.getTime() + BUSINESS_UTC_OFFSET_MS);
const fromLocal = (d: Date) => new Date(d.getTime() - BUSINESS_UTC_OFFSET_MS);

function hm(time: string): [number, number] {
  const m = TIME_RE.exec(time);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

function daysInMonth(local: Date): number {
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
}

/** The cutoff that falls in the same day / week / month as `local`. */
function cutoffInUnit(period: BonusPeriod, c: RebateCutoffs, local: Date): Date {
  const d = new Date(local.getTime());
  if (period === "daily") {
    const [h, m] = hm(c.daily.time);
    d.setUTCHours(h, m, 0, 0);
  } else if (period === "weekly") {
    const [h, m] = hm(c.weekly.time);
    const back = (d.getUTCDay() - c.weekly.weekday + 7) % 7;
    d.setUTCDate(d.getUTCDate() - back);
    d.setUTCHours(h, m, 0, 0);
  } else {
    const [h, m] = hm(c.monthly.time);
    d.setUTCDate(Math.min(c.monthly.day, daysInMonth(d)));
    d.setUTCHours(h, m, 0, 0);
  }
  return d;
}

/** Move a cutoff by `n` periods (negative = earlier), in business time. */
function stepUnit(period: BonusPeriod, c: RebateCutoffs, local: Date, n: number): Date {
  const d = new Date(local.getTime());
  if (period === "daily") {
    d.setUTCDate(d.getUTCDate() + n);
  } else if (period === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7 * n);
  } else {
    // Walk from the 1st so a clamped day (the 31st in a short month) doesn't
    // spill into the wrong month, then re-clamp in the target month.
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    d.setUTCDate(Math.min(c.monthly.day, daysInMonth(d)));
  }
  return d;
}

/** The most recent cutoff at or before `now` — when the current window opened. */
export function latestCutoff(period: BonusPeriod, c: RebateCutoffs, now = new Date()): Date {
  const local = toLocal(now);
  let cut = cutoffInUnit(period, c, local);
  if (cut.getTime() > local.getTime()) cut = stepUnit(period, c, cut, -1);
  return fromLocal(cut);
}

export function shiftCutoff(period: BonusPeriod, c: RebateCutoffs, cutoff: Date, n: number): Date {
  return fromLocal(stepUnit(period, c, toLocal(cutoff), n));
}

export type RebateWindow = { start: Date; end: Date };

/** The window that just closed: from the previous cutoff up to the latest. */
export function latestClosedWindow(period: BonusPeriod, c: RebateCutoffs, now = new Date()): RebateWindow {
  const end = latestCutoff(period, c, now);
  return { start: shiftCutoff(period, c, end, -1), end };
}

/** The window still open: from the latest cutoff to the next one. */
export function currentWindow(period: BonusPeriod, c: RebateCutoffs, now = new Date()): RebateWindow {
  const start = latestCutoff(period, c, now);
  return { start, end: shiftCutoff(period, c, start, 1) };
}

/** The last `n` closed windows, newest first — what "Generate" may be pointed at. */
export function recentClosedWindows(
  period: BonusPeriod,
  c: RebateCutoffs,
  n: number,
  now = new Date(),
): RebateWindow[] {
  const out: RebateWindow[] = [];
  let end = latestCutoff(period, c, now);
  for (let i = 0; i < n; i++) {
    const start = shiftCutoff(period, c, end, -1);
    out.push({ start, end });
    end = start;
  }
  return out;
}

// ---- who qualifies ----------------------------------------------------------

export type RebateCandidate = {
  player_id: number;
  username: string;
  full_name: string;
  company_entity_id: number | null;
  deposits_total: number;
  withdrawals_total: number;
  net_loss: number;
  amount: number;
  game_name: string | null;
  game_username: string | null;
};

const money = (n: number) => +n.toFixed(2);

/**
 * Every player in scope whose loss over the window clears the plan's minimum,
 * with the rebate figure and the game to credit — the one they lost most on,
 * failing that the last account linked (that's the one they're currently on).
 */
export async function computeRebateCandidates(
  plan: BonusPlan,
  window: RebateWindow,
  companyIds: number[] | null,
): Promise<RebateCandidate[]> {
  const startIso = window.start.toISOString();
  const endIso = window.end.toISOString();

  const depRows = await db
    .select({
      player_id: deposits.player_id,
      game: deposits.selected_game,
      total: sql<number>`coalesce(sum(${deposits.deposit_amount}), 0)::float8`,
    })
    .from(deposits)
    .where(
      and(
        eq(deposits.status, "completed"),
        gte(deposits.deposit_date, startIso),
        lt(deposits.deposit_date, endIso),
      ),
    )
    .groupBy(deposits.player_id, deposits.selected_game);

  // Paid withdrawals only — a request that hasn't been paid hasn't left the
  // player's balance. What left is what the agent actually pulled; the
  // requested figure stands in when the pull amount wasn't recorded.
  const wdRows = await db
    .select({
      player_id: withdrawals.player_id,
      total: sql<number>`coalesce(sum(coalesce(nullif(${withdrawals.credit_pulled_amount}, 0), ${withdrawals.requested_amount}, 0)), 0)::float8`,
    })
    .from(withdrawals)
    .where(
      and(
        eq(withdrawals.status, "paid"),
        gte(withdrawals.paid_at, startIso),
        lt(withdrawals.paid_at, endIso),
      ),
    )
    .groupBy(withdrawals.player_id);

  const depByPlayer = new Map<number, number>();
  const gameByPlayer = new Map<number, Map<string, number>>();
  for (const r of depRows) {
    if (r.player_id == null) continue;
    depByPlayer.set(r.player_id, (depByPlayer.get(r.player_id) ?? 0) + r.total);
    if (r.game) {
      const g = gameByPlayer.get(r.player_id) ?? new Map<string, number>();
      g.set(r.game, (g.get(r.game) ?? 0) + r.total);
      gameByPlayer.set(r.player_id, g);
    }
  }
  const wdByPlayer = new Map<number, number>();
  for (const r of wdRows) wdByPlayer.set(r.player_id, r.total);

  // Only a net loss can earn a rebate, and it needs deposits to exist at all.
  const ids = [...depByPlayer.keys()].filter(
    (id) => depByPlayer.get(id)! - (wdByPlayer.get(id) ?? 0) > 0,
  );
  if (!ids.length) return [];

  // Scope: the plan's own company when it has one, else whatever the caller
  // may see (null = the whole house).
  const scope = plan.company_entity_id !== null ? [plan.company_entity_id] : companyIds;
  const playerRows = await db
    .select({
      player_id: players.player_id,
      username: players.username,
      full_name: players.full_name,
      company_entity_id: players.company_entity_id,
      game_accounts: players.game_accounts,
    })
    .from(players)
    .where(
      and(
        inArray(players.player_id, ids),
        scope === null
          ? undefined
          : scope.length
            ? inArray(players.company_entity_id, scope)
            : sql`false`,
      ),
    );

  const out: RebateCandidate[] = [];
  for (const p of playerRows) {
    const dep = money(depByPlayer.get(p.player_id) ?? 0);
    const wd = money(wdByPlayer.get(p.player_id) ?? 0);
    const loss = money(dep - wd);
    if (loss <= 0 || loss < plan.min_loss) continue;

    const accounts = p.game_accounts ?? [];
    const byGame = gameByPlayer.get(p.player_id);
    let game: string | null = null;
    if (byGame) {
      const ranked = [...byGame.entries()].sort((a, b) => b[1] - a[1]);
      // The game they lost most on, provided they still hold an account there.
      game =
        ranked.find(([g]) => accounts.some((a) => a.game_name.toLowerCase() === g.toLowerCase()))?.[0] ??
        null;
    }
    if (!game && accounts.length) game = accounts[accounts.length - 1].game_name;
    const login = game
      ? (accounts.find((a) => a.game_name.toLowerCase() === game!.toLowerCase())?.game_username ?? null)
      : null;

    out.push({
      player_id: p.player_id,
      username: p.username,
      full_name: p.full_name,
      company_entity_id: p.company_entity_id,
      deposits_total: dep,
      withdrawals_total: wd,
      net_loss: loss,
      amount: money((loss * plan.percentage) / 100),
      game_name: game,
      game_username: login,
    });
  }
  return out.sort((a, b) => b.net_loss - a.net_loss);
}

// ---- the snapshot -----------------------------------------------------------

export type GenerateResult =
  | { ok: true; window: RebateWindow; inserted: number; replaced: number }
  | { ok: false; status: number; reason: string };

/**
 * Snapshot one closed window for a plan — the latest by default, or any
 * earlier one (a day nobody ran) named by its end cutoff. Re-running before
 * anything is paid replaces the list (a withdrawal paid after the first run
 * would change the figures); once any row is paid the list is frozen.
 */
export async function generateRebateList(
  plan: BonusPlan,
  cutoffs: RebateCutoffs,
  user: AuthedUser,
  now = new Date(),
  windowEnd?: Date,
): Promise<GenerateResult> {
  if (plan.type !== "rebate" || !plan.period) {
    return { ok: false, status: 400, reason: `"${plan.name}" is not a rebate plan` };
  }
  let window: RebateWindow;
  if (windowEnd) {
    // Only a real cutoff instant that has already passed names a window —
    // anything else would measure a loss over a span no one agreed on.
    const latest = latestCutoff(plan.period, cutoffs, now);
    const onCutoff = latestCutoff(plan.period, cutoffs, windowEnd).getTime() === windowEnd.getTime();
    if (!onCutoff || windowEnd.getTime() > latest.getTime()) {
      return { ok: false, status: 400, reason: "That isn't a closed window for this plan's cutoffs" };
    }
    window = { start: shiftCutoff(plan.period, cutoffs, windowEnd, -1), end: windowEnd };
  } else {
    window = latestClosedWindow(plan.period, cutoffs, now);
  }
  const startIso = window.start.toISOString();

  const existing = await db
    .select({ payout_id: rebatePayouts.payout_id, status: rebatePayouts.status })
    .from(rebatePayouts)
    .where(and(eq(rebatePayouts.plan_id, plan.plan_id), eq(rebatePayouts.window_start, startIso)));
  if (existing.some((r) => r.status === "paid")) {
    return {
      ok: false,
      status: 409,
      reason: "This window's list already has payouts made — it can't be regenerated",
    };
  }

  const candidates = await computeRebateCandidates(plan, window, user.companyIds);
  const nowIso = now.toISOString();

  await db.transaction(async (txn) => {
    if (existing.length) {
      await txn
        .delete(rebatePayouts)
        .where(and(eq(rebatePayouts.plan_id, plan.plan_id), eq(rebatePayouts.window_start, startIso)));
    }
    if (candidates.length) {
      await txn.insert(rebatePayouts).values(
        candidates.map((c) => ({
          plan_id: plan.plan_id,
          player_id: c.player_id,
          company_entity_id: c.company_entity_id,
          period: plan.period!,
          window_start: startIso,
          window_end: window.end.toISOString(),
          deposits_total: c.deposits_total,
          withdrawals_total: c.withdrawals_total,
          net_loss: c.net_loss,
          percentage: plan.percentage,
          amount: c.amount,
          game_name: c.game_name,
          game_username: c.game_username,
          generated_by_user_id: user.user_id,
          generated_at: nowIso,
        })),
      );
    }
  });

  return { ok: true, window, inserted: candidates.length, replaced: existing.length };
}

// ---- reading it back --------------------------------------------------------

export type RebateLiveStatus =
  | "pending"
  | "skipped"
  | "queued"
  | "processing"
  | "credited"
  | "failed";

export type RebatePayoutView = {
  payout_id: number;
  plan_id: number;
  player_id: number;
  username: string;
  full_name: string;
  company_entity_id: number | null;
  window_start: string;
  window_end: string;
  deposits_total: number;
  withdrawals_total: number;
  net_loss: number;
  percentage: number;
  amount: number;
  status: "pending" | "paid" | "skipped";
  /** What's actually happened to the credit, agent progress included. */
  live_status: RebateLiveStatus;
  game_name: string | null;
  game_username: string | null;
  skip_bot: boolean;
  game_transfer_id: number | null;
  generated_at: string;
  paid_by_user_id: number | null;
  paid_at: string | null;
  note: string | null;
};

export type RebateWindowSummary = {
  window_start: string;
  window_end: string;
  rows: number;
  paid: number;
  pending: number;
  skipped: number;
  total: number;
  generated_at: string;
};

function scopeFilter(companyIds: number[] | null) {
  if (companyIds === null) return undefined;
  return companyIds.length ? inArray(rebatePayouts.company_entity_id, companyIds) : sql`false`;
}

/** Every window generated for a plan, newest first. */
export async function listRebateWindows(
  planId: number,
  companyIds: number[] | null,
): Promise<RebateWindowSummary[]> {
  const rows = await db
    .select({
      window_start: rebatePayouts.window_start,
      window_end: rebatePayouts.window_end,
      rows: sql<number>`count(*)::int`,
      paid: sql<number>`count(*) filter (where ${rebatePayouts.status} = 'paid')::int`,
      pending: sql<number>`count(*) filter (where ${rebatePayouts.status} = 'pending')::int`,
      skipped: sql<number>`count(*) filter (where ${rebatePayouts.status} = 'skipped')::int`,
      total: sql<number>`coalesce(sum(${rebatePayouts.amount}) filter (where ${rebatePayouts.status} <> 'skipped'), 0)::float8`,
      generated_at: sql<string>`max(${rebatePayouts.generated_at})`,
    })
    .from(rebatePayouts)
    .where(and(eq(rebatePayouts.plan_id, planId), scopeFilter(companyIds)))
    .groupBy(rebatePayouts.window_start, rebatePayouts.window_end)
    .orderBy(desc(rebatePayouts.window_start));
  return rows;
}

export async function listRebatePayouts(
  planId: number,
  windowStart: string,
  companyIds: number[] | null,
): Promise<RebatePayoutView[]> {
  const rows = await db
    .select({
      p: rebatePayouts,
      username: players.username,
      full_name: players.full_name,
      transfer_status: gameTransfers.status,
    })
    .from(rebatePayouts)
    .innerJoin(players, eq(players.player_id, rebatePayouts.player_id))
    .leftJoin(gameTransfers, eq(gameTransfers.transfer_id, rebatePayouts.game_transfer_id))
    .where(
      and(
        eq(rebatePayouts.plan_id, planId),
        eq(rebatePayouts.window_start, windowStart),
        scopeFilter(companyIds),
      ),
    )
    .orderBy(desc(rebatePayouts.net_loss), asc(players.username));

  return rows.map(({ p, username, full_name, transfer_status }) => {
    let live: RebateLiveStatus;
    if (p.status === "pending") live = "pending";
    else if (p.status === "skipped") live = "skipped";
    else if (p.skip_bot || !p.game_transfer_id || !transfer_status) live = "credited";
    else if (transfer_status === "completed") live = "credited";
    else if (transfer_status === "failed") live = "failed";
    else if (transfer_status === "pending") live = "queued";
    else live = "processing";
    return {
      payout_id: p.payout_id,
      plan_id: p.plan_id,
      player_id: p.player_id,
      username,
      full_name,
      company_entity_id: p.company_entity_id,
      window_start: p.window_start,
      window_end: p.window_end,
      deposits_total: p.deposits_total,
      withdrawals_total: p.withdrawals_total,
      net_loss: p.net_loss,
      percentage: p.percentage,
      amount: p.amount,
      status: p.status,
      live_status: live,
      game_name: p.game_name,
      game_username: p.game_username,
      skip_bot: p.skip_bot,
      game_transfer_id: p.game_transfer_id,
      generated_at: p.generated_at,
      paid_by_user_id: p.paid_by_user_id,
      paid_at: p.paid_at,
      note: p.note,
    };
  });
}

/**
 * The rebate plan a request names, checked against the caller: it must be a
 * rebate, and it must be one their companies are offered.
 */
export async function loadRebatePlanForUser(user: AuthedUser, planId: number): Promise<BonusPlan> {
  const [plan] = await db.select().from(bonusPlans).where(eq(bonusPlans.plan_id, planId));
  if (!plan || plan.type !== "rebate") throw new AuthError(404, "Rebate plan not found");
  if (
    plan.company_entity_id !== null &&
    user.companyIds !== null &&
    !user.companyIds.includes(plan.company_entity_id)
  ) {
    throw new AuthError(403, "That rebate plan belongs to another company");
  }
  return plan;
}

/**
 * One row of the page's window list: a closed window, generated or not.
 * ISO instants throughout (Postgres' own spelling is normalised away) so the
 * client can key on `start` and pass it straight back.
 */
export type RebateWindowRow = {
  start: string;
  end: string;
  generated: boolean;
  rows: number;
  paid: number;
  pending: number;
  skipped: number;
  total: number;
  generated_at: string | null;
  /** Something in it is paid — the list can't be regenerated. */
  frozen: boolean;
};

/** Everything the Rebates page shows for one plan tab. */
export type RebatePlanData = {
  plan: BonusPlan;
  cutoffs: RebateCutoffs;
  cutoff_label: string;
  current_window: { start: string; end: string };
  /** Recent closed windows plus any older generated ones, newest first. */
  windows: RebateWindowRow[];
  /** The window whose payouts were asked for, or null. */
  payouts_for: string | null;
  payouts: RebatePayoutView[];
};

/** How many closed windows the list always shows, generated or not. */
const RECENT_WINDOWS = 14;

const iso = (s: string | Date) => new Date(s).toISOString();

export async function rebatePlanData(
  plan: BonusPlan,
  cutoffs: RebateCutoffs,
  companyIds: number[] | null,
  requestedWindowStart: string | null,
  now = new Date(),
): Promise<RebatePlanData> {
  const period = plan.period ?? "daily";
  const current = currentWindow(period, cutoffs, now);
  const generated = await listRebateWindows(plan.plan_id, companyIds);
  const byStart = new Map(generated.map((g) => [iso(g.window_start), g]));

  const rows = new Map<string, RebateWindowRow>();
  for (const w of recentClosedWindows(period, cutoffs, RECENT_WINDOWS, now)) {
    const start = w.start.toISOString();
    const g = byStart.get(start);
    rows.set(start, {
      start,
      end: w.end.toISOString(),
      generated: !!g,
      rows: g?.rows ?? 0,
      paid: g?.paid ?? 0,
      pending: g?.pending ?? 0,
      skipped: g?.skipped ?? 0,
      total: g?.total ?? 0,
      generated_at: g ? iso(g.generated_at) : null,
      frozen: (g?.paid ?? 0) > 0,
    });
  }
  // Older generated windows (or ones from before a cutoff change) still show.
  for (const g of generated) {
    const start = iso(g.window_start);
    if (rows.has(start)) continue;
    rows.set(start, {
      start,
      end: iso(g.window_end),
      generated: true,
      rows: g.rows,
      paid: g.paid,
      pending: g.pending,
      skipped: g.skipped,
      total: g.total,
      generated_at: iso(g.generated_at),
      frozen: g.paid > 0,
    });
  }
  const windows = [...rows.values()].sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0));

  // Payouts for one window, when asked: query by the DB's own spelling of the
  // start so the equality matches.
  let payouts: RebatePayoutView[] = [];
  let payoutsFor: string | null = null;
  if (requestedWindowStart) {
    const g = generated.find((x) => iso(x.window_start) === iso(requestedWindowStart));
    if (g) {
      payoutsFor = iso(g.window_start);
      payouts = await listRebatePayouts(plan.plan_id, g.window_start, companyIds);
    }
  }

  return {
    plan,
    cutoffs,
    cutoff_label: describeCutoff(period, cutoffs),
    current_window: { start: current.start.toISOString(), end: current.end.toISOString() },
    windows,
    payouts_for: payoutsFor,
    payouts,
  };
}

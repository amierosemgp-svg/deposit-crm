import { and, asc, eq, gt, inArray, isNull, like, lt, min } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  entities,
  salaryAdjustments,
  salaryTiers,
  staffBaseSalaries,
  staffDayMarks,
  staffTierRates,
  users,
  workSessions,
} from "@/db/schema";

/**
 * Staff pay arithmetic (22 Oct 2026 — base salary + attendance; the tier
 * ladder below is kept only for the history it explains):
 *
 *   - Each CS has one monthly base salary.
 *   - No schedule. A day with time on the clock is worked; a day without is
 *     off. A leader can mark a day off as told ("notified" — MC, emergency,
 *     leave), or a worked day as off anyway (half a day then emergency leave
 *     is a whole day off).
 *   - FREE_DAYS_OFF a month cost nothing. Each one past that costs
 *     TOLD_DAY_OFF if it was told, UNTOLD_DAY_OFF if not, in date order.
 *   - Each unused free day pays EXTRA_DAY; a month with no day off at all
 *     pays NO_DAY_OFF_BONUS instead.
 *   - Deductions and penalties stop at zero. Only an advance takes a salary
 *     below zero, and that shortfall carries to the next one.
 *
 * The pure parts are separate from the reads so the numbers can be checked
 * without a database.
 */

type Db = typeof db;
type Txn = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Q = Db | Txn;

/** Setting: the CS share of a staff penalty's loss, in percent (default 50). */
export const STAFF_PENALTY_SHARE_KEY = "staff_penalty_share_pct";

/** Malaysia is UTC+8 all year — no daylight saving to account for. */
const MYT_MS = 8 * 3600_000;

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** "2026-10" → [start, end) of that month in business time, as epoch ms. */
export function monthBounds(month: string): { startMs: number; endMs: number } {
  const [y, m] = month.split("-").map(Number);
  return {
    startMs: Date.UTC(y, m - 1, 1) - MYT_MS,
    endMs: Date.UTC(y, m, 1) - MYT_MS,
  };
}

export function isMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** The business-time month an instant falls in. */
export function monthOf(iso: string | Date): string {
  return new Date(new Date(iso).getTime() + MYT_MS).toISOString().slice(0, 7);
}

export type SessionSpan = { started_at: string; last_active_at: string };

/**
 * Worked time inside [startMs, endMs), per business day.
 *
 * A session runs from sign-in to its last activity. One that crosses midnight
 * is split at it, so a 22:00–02:00 shift is two hours on each day and both
 * days count as worked.
 */
export function rollupSessions(
  sessions: SessionSpan[],
  startMs: number,
  endMs: number,
): { totalMs: number; byDay: Map<string, number> } {
  const byDay = new Map<string, number>();
  let totalMs = 0;
  for (const s of sessions) {
    let from = Math.max(new Date(s.started_at).getTime(), startMs);
    const to = Math.min(new Date(s.last_active_at).getTime(), endMs);
    while (from < to) {
      // The next business midnight after `from`.
      const local = from + MYT_MS;
      const nextMidnight = local - (local % 86_400_000) + 86_400_000 - MYT_MS;
      const stop = Math.min(to, nextMidnight);
      const day = new Date(from + MYT_MS).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + (stop - from));
      totalMs += stop - from;
      from = stop;
    }
  }
  return { totalMs, byDay };
}

export type Worked = {
  hours: number;
  days: number;
  /** "YYYY-MM-DD" → hours, business days with any time on them. */
  daily: Record<string, number>;
};

export function toWorked(r: { totalMs: number; byDay: Map<string, number> }): Worked {
  const daily: Record<string, number> = {};
  for (const [day, ms] of [...r.byDay.entries()].sort()) {
    if (ms > 0) daily[day] = round2(ms / 3_600_000);
  }
  return {
    hours: round2(r.totalMs / 3_600_000),
    days: Object.keys(daily).length,
    daily,
  };
}

// ---------- attendance ----------

export const FREE_DAYS_OFF = 4;
export const TOLD_DAY_OFF = 100;
export const UNTOLD_DAY_OFF = 200;
export const EXTRA_DAY = 100;
export const NO_DAY_OFF_BONUS = 500;

export type DayMark = "notified" | "not_notified";
export type DayStatus = "worked" | "off_told" | "off_untold" | "free" | "not_counted";

export type AttendanceDay = {
  day: string;
  hours: number;
  mark: DayMark | null;
  status: DayStatus;
  /** What this day did to the salary: −100, −200, or 0. */
  amount: number;
};

export type Attendance = {
  /** Days the month has counted so far (from the CS's first day, up to yesterday). */
  counted: number;
  worked: number;
  off: number;
  off_told: number;
  off_untold: number;
  /** Days off inside the allowance. */
  free_used: number;
  /** Days off past it, charged. */
  charged_told: number;
  charged_untold: number;
  deduction: number;
  bonus: number;
  /** bonus − deduction. */
  amount: number;
  /** False while the month is still running: the bonus is "so far". */
  complete: boolean;
  days: AttendanceDay[];
};

const addDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Today's date in business time. */
export const todayMyt = () => new Date(Date.now() + MYT_MS).toISOString().slice(0, 10);

/**
 * The month's days off and what they do to the salary.
 *
 * Counts from `firstDay` (the CS's first day on the clock — before it they
 * didn't work here, or the clock didn't exist) up to yesterday; today isn't
 * over. The free allowance goes to the earliest days off.
 */
export function attendanceFor(
  month: string,
  daily: Record<string, number>,
  marks: Record<string, DayMark>,
  firstDay: string | null,
  today: string = todayMyt(),
): Attendance {
  const start = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const complete = nextMonth <= today;
  const days: AttendanceDay[] = [];
  let off = 0;
  const a = { worked: 0, off_told: 0, off_untold: 0, free_used: 0, charged_told: 0, charged_untold: 0, deduction: 0 };
  for (let d = start; d < nextMonth; d = addDay(d, 1)) {
    const hours = daily[d] ?? 0;
    const mark = marks[d] ?? null;
    if (d >= today || !firstDay || d < firstDay) {
      days.push({ day: d, hours, mark, status: "not_counted", amount: 0 });
      continue;
    }
    if (hours > 0 && !mark) {
      a.worked++;
      days.push({ day: d, hours, mark, status: "worked", amount: 0 });
      continue;
    }
    const told = mark === "notified";
    if (told) a.off_told++;
    else a.off_untold++;
    off++;
    if (off <= FREE_DAYS_OFF) {
      a.free_used++;
      days.push({ day: d, hours, mark, status: "free", amount: 0 });
      continue;
    }
    const cost = told ? TOLD_DAY_OFF : UNTOLD_DAY_OFF;
    if (told) a.charged_told++;
    else a.charged_untold++;
    a.deduction += cost;
    days.push({ day: d, hours, mark, status: told ? "off_told" : "off_untold", amount: -cost });
  }
  const counted = a.worked + off;
  // Nothing counted yet (a CS who hasn't started) earns no bonus either.
  const bonus = counted === 0 ? 0 : off === 0 ? NO_DAY_OFF_BONUS : Math.max(0, FREE_DAYS_OFF - off) * EXTRA_DAY;
  return { counted, off, ...a, bonus, amount: bonus - a.deduction, complete, days };
}

export type Tier = {
  tier_id: number;
  name: string;
  min_hours: number;
  min_days: number;
  basis: "monthly" | "hourly";
  default_amount: number;
};

/**
 * The highest rung reached: both its hours and its days met. Rungs are ranked
 * by hours, then days — a ladder where a higher rung asks for fewer of either
 * is a ladder typed wrong, and this still picks the one that asks the most.
 */
export function pickTier<T extends Tier>(tiers: T[], hours: number, days: number): T | null {
  const reached = tiers.filter((t) => hours >= t.min_hours && days >= t.min_days);
  reached.sort((a, b) => b.min_hours - a.min_hours || b.min_days - a.min_days);
  return reached[0] ?? null;
}

/** A rung's pay for this person: a month's amount, or a rate × hours. */
export function tierPay(tier: Tier, rate: number, hours: number): number {
  return tier.basis === "hourly" ? round2(rate * hours) : round2(rate);
}

/** Money already paid out early: an advance, or an advance an earlier salary couldn't cover. */
export const isAdvance = (kind: string) => kind === "advance" || kind === "carry";

/**
 * What the salary pays. Base, attendance, bonuses, deductions and penalties
 * stop at zero; advances come off after that, and an advance the salary can't
 * cover carries to the next one.
 */
export function settle(base: number, attendance: number, adjustments: Array<{ kind: string; amount: number }>) {
  const earned = adjustments.filter((a) => !isAdvance(a.kind)).reduce((n, a) => n + a.amount, 0);
  const advances = adjustments.filter((a) => isAdvance(a.kind)).reduce((n, a) => n + a.amount, 0);
  const gross = round2(base + attendance + earned + advances);
  const floored = Math.max(round2(base + attendance + earned), 0);
  const afterAdvances = round2(floored + advances);
  return {
    gross,
    /** What the floor wrote off: deductions and penalties past zero. */
    waived: round2(floored - (base + attendance + earned)),
    net: Math.max(afterAdvances, 0),
    carried: afterAdvances < 0 ? round2(-afterAdvances) : 0,
  };
}

/** A staff penalty's figures. Bonus credit counts: it was credit, and it was spent. */
export function penaltyFigures(injected: number, retrieved: number, sharePct: number) {
  const loss = round2(injected - retrieved);
  return { loss, amount: round2((loss * sharePct) / 100) };
}

// ---------- reads ----------

/**
 * The casino a CS agent works at: their desk's parent. Salary ladders are per
 * casino, and that is whose bank pays them.
 */
export async function csCasino(q: Q, userId: number) {
  const [row] = await q
    .select({ user: users, desk: entities })
    .from(users)
    .innerJoin(entities, eq(entities.entity_id, users.entity_id))
    .where(eq(users.user_id, userId));
  if (!row || row.user.role !== "cs_agent") return null;
  if (row.desk.entity_type !== "cs" || !row.desk.parent_entity_id) return null;
  return { user: row.user, casinoId: row.desk.parent_entity_id };
}

/** Sessions touching [startMs, endMs) for these people. */
export async function sessionsFor(q: Q, userIds: number[], month: string) {
  if (!userIds.length) return [];
  const { startMs, endMs } = monthBounds(month);
  return q
    .select({
      user_id: workSessions.user_id,
      started_at: workSessions.started_at,
      last_active_at: workSessions.last_active_at,
    })
    .from(workSessions)
    .where(
      and(
        inArray(workSessions.user_id, userIds),
        lt(workSessions.started_at, new Date(endMs).toISOString()),
        gt(workSessions.last_active_at, new Date(startMs).toISOString()),
      ),
    );
}

export async function workedFor(q: Q, userId: number, month: string): Promise<Worked> {
  const { startMs, endMs } = monthBounds(month);
  return toWorked(rollupSessions(await sessionsFor(q, [userId], month), startMs, endMs));
}

/** Each CS's base salary (0 when none is set). */
export async function baseSalaries(q: Q, userIds: number[]): Promise<Map<number, number>> {
  if (!userIds.length) return new Map();
  const rows = await q.select().from(staffBaseSalaries).where(inArray(staffBaseSalaries.user_id, userIds));
  return new Map(rows.map((r) => [r.user_id, r.amount]));
}

/** Leaders' marks on the month's days, per CS: user → day → mark. */
export async function dayMarks(q: Q, userIds: number[], month: string): Promise<Map<number, Record<string, DayMark>>> {
  const out = new Map<number, Record<string, DayMark>>();
  if (!userIds.length) return out;
  const rows = await q
    .select()
    .from(staffDayMarks)
    .where(and(inArray(staffDayMarks.user_id, userIds), like(staffDayMarks.day, `${month}-%`)));
  for (const r of rows) out.set(r.user_id, { ...(out.get(r.user_id) ?? {}), [r.day]: r.mark });
  return out;
}

/** Each CS's first day on the clock (business date), or null if never. */
export async function firstDays(q: Q, userIds: number[]): Promise<Map<number, string | null>> {
  if (!userIds.length) return new Map();
  const rows = await q
    .select({ user_id: workSessions.user_id, first: min(workSessions.started_at) })
    .from(workSessions)
    .where(inArray(workSessions.user_id, userIds))
    .groupBy(workSessions.user_id);
  return new Map(rows.map((r) => [r.user_id, r.first ? monthDay(r.first) : null]));
}

/** The business date an instant falls on. */
export const monthDay = (iso: string) => new Date(new Date(iso).getTime() + MYT_MS).toISOString().slice(0, 10);

export async function activeTiers(q: Q, casinoId: number): Promise<Tier[]> {
  const rows = await q
    .select()
    .from(salaryTiers)
    .where(and(eq(salaryTiers.company_entity_id, casinoId), eq(salaryTiers.status, "active")))
    .orderBy(asc(salaryTiers.min_hours), asc(salaryTiers.min_days));
  return rows;
}

export async function rateFor(q: Q, userId: number, tier: Tier): Promise<number> {
  const [own] = await q
    .select()
    .from(staffTierRates)
    .where(and(eq(staffTierRates.user_id, userId), eq(staffTierRates.tier_id, tier.tier_id)));
  return own?.amount ?? tier.default_amount;
}

export type SalaryPreview = {
  user_id: number;
  full_name: string;
  company_entity_id: number;
  month: string;
  worked: Worked;
  base: number;
  attendance: Attendance;
  adjustments: Array<{
    adjustment_id: number;
    kind: "bonus" | "deduction" | "penalty" | "carry" | "advance";
    amount: number;
    reason: string;
    occurred_at: string;
    penalty_id: number | null;
  }>;
  adjustments_total: number;
  gross: number;
  waived: number;
  net: number;
  carried: number;
};

/**
 * Everything a salary would pay, without paying it.
 *
 * Inside the pay transaction, `lock` holds the pending adjustments so a penalty
 * recorded mid-payment either makes this salary or waits for the next — never
 * both, never neither.
 */
export async function computeSalary(
  q: Q,
  userId: number,
  month: string,
  opts: { lock?: boolean } = {},
): Promise<SalaryPreview | { error: string }> {
  const cs = await csCasino(q, userId);
  if (!cs) return { error: "Salary is for CS agents — this account isn't one, or has no desk" };

  const [worked, bases, marks, firsts] = await Promise.all([
    workedFor(q, userId, month),
    baseSalaries(q, [userId]),
    dayMarks(q, [userId], month),
    firstDays(q, [userId]),
  ]);
  const base = bases.get(userId) ?? 0;
  const attendance = attendanceFor(month, worked.daily, marks.get(userId) ?? {}, firsts.get(userId) ?? null);

  const pendingQuery = q
    .select()
    .from(salaryAdjustments)
    .where(and(eq(salaryAdjustments.user_id, userId), isNull(salaryAdjustments.salary_id)))
    .orderBy(asc(salaryAdjustments.occurred_at));
  const pending = opts.lock ? await pendingQuery.for("update") : await pendingQuery;

  const adjustments_total = round2(pending.reduce((a, r) => a + r.amount, 0));
  const { gross, waived, net, carried } = settle(base, attendance.amount, pending);

  return {
    user_id: userId,
    full_name: cs.user.full_name,
    company_entity_id: cs.casinoId,
    month,
    worked,
    base,
    attendance,
    adjustments: pending.map((r) => ({
      adjustment_id: r.adjustment_id,
      kind: r.kind,
      amount: r.amount,
      reason: r.reason,
      occurred_at: r.occurred_at,
      penalty_id: r.penalty_id,
    })),
    adjustments_total,
    gross,
    waived,
    net,
    carried,
  };
}

// ---------- who may ----------

/** A casino this user works for. `companyIds` null is unrestricted (see resolveScope). */
export function inCasinoScope(user: { companyIds: number[] | null }, casinoId: number): boolean {
  return user.companyIds === null || user.companyIds.includes(casinoId);
}

/** A base salary as the editor sends it. */
export const baseSalarySchema = z.object({
  user_id: z.number().int().positive(),
  amount: z.number().min(0).max(1_000_000),
});

/** A leader's mark on one day; null clears it. */
export const dayMarkSchema = z.object({
  user_id: z.number().int().positive(),
  day: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
  mark: z.enum(["notified", "not_notified"]).nullable(),
  note: z.string().trim().max(200).optional(),
});

/**
 * Paying a salary, adding a bonus or deduction, and voiding a penalty change
 * what someone takes home, so they sit with leaders and the admin. Recording a
 * penalty and editing the ladder are open to the desk (by request) — a wrong
 * penalty is voided before payday, and nobody sets their own rate.
 */
export function canManagePay(role: string): boolean {
  return role === "super_admin" || role === "company_leader";
}

/** A rung as the ladder editor sends it. */
export const tierSchema = z.object({
  company_entity_id: z.number().int().positive(),
  name: z.string().trim().min(1).max(60),
  min_hours: z.number().min(0).max(744),
  min_days: z.number().int().min(0).max(31),
  basis: z.enum(["monthly", "hourly"]),
  default_amount: z.number().min(0),
});

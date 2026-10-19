import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  entities,
  salaryAdjustments,
  salaryTiers,
  staffTierRates,
  users,
  workSessions,
} from "@/db/schema";

/**
 * Staff pay arithmetic: hours and days from the work clock, the rung of the
 * casino's ladder they reached, what it pays this person, and what the pending
 * adjustments do to it. The pure parts are separate from the reads so the
 * numbers can be checked without a database.
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

/**
 * Base + adjustments, and what happens when that's below zero: nothing is
 * paid and the shortfall carries to the next salary.
 */
export function settle(base: number, adjustmentsTotal: number) {
  const gross = round2(base + adjustmentsTotal);
  return { gross, net: Math.max(gross, 0), carried: gross < 0 ? round2(-gross) : 0 };
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
  tier: (Tier & { rate: number }) | null;
  base: number;
  adjustments: Array<{
    adjustment_id: number;
    kind: "bonus" | "deduction" | "penalty" | "carry";
    amount: number;
    reason: string;
    occurred_at: string;
    penalty_id: number | null;
  }>;
  adjustments_total: number;
  gross: number;
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

  const worked = await workedFor(q, userId, month);
  const tiers = await activeTiers(q, cs.casinoId);
  const reached = pickTier(tiers, worked.hours, worked.days);
  const rate = reached ? await rateFor(q, userId, reached) : 0;
  const base = reached ? tierPay(reached, rate, worked.hours) : 0;

  const pendingQuery = q
    .select()
    .from(salaryAdjustments)
    .where(and(eq(salaryAdjustments.user_id, userId), isNull(salaryAdjustments.salary_id)))
    .orderBy(asc(salaryAdjustments.occurred_at));
  const pending = opts.lock ? await pendingQuery.for("update") : await pendingQuery;

  const adjustments_total = round2(pending.reduce((a, r) => a + r.amount, 0));
  const { gross, net, carried } = settle(base, adjustments_total);

  return {
    user_id: userId,
    full_name: cs.user.full_name,
    company_entity_id: cs.casinoId,
    month,
    worked,
    tier: reached ? { ...reached, rate } : null,
    base,
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
    net,
    carried,
  };
}

// ---------- who may ----------

/** A casino this user works for. `companyIds` null is unrestricted (see resolveScope). */
export function inCasinoScope(user: { companyIds: number[] | null }, casinoId: number): boolean {
  return user.companyIds === null || user.companyIds.includes(casinoId);
}

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

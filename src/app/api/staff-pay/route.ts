import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  entities,
  salaryAdjustments,
  salaryPayments,
  salaryTiers,
  staffPenalties,
  staffTierRates,
  users,
} from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { getSettingNumber, jsonError } from "@/lib/api-helpers";
import {
  isMonth,
  monthBounds,
  monthOf,
  pickTier,
  rollupSessions,
  sessionsFor,
  tierPay,
  toWorked,
  round2,
  STAFF_PENALTY_SHARE_KEY,
} from "@/lib/salary";

/**
 * GET /api/staff-pay?month=YYYY-MM — everything the Salary and Staff Penalty
 * sheets show, for the casinos this user works at.
 *
 * Per CS for the month: hours, days, the rung reached so far, what it would
 * pay, and what's pending against their next salary. Plus the ladders, the
 * per-person rates, the payslips, adjustments and penalties.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const monthParam = new URL(request.url).searchParams.get("month");
    const month = monthParam && isMonth(monthParam) ? monthParam : monthOf(new Date());

    const scope = (col: SQL | AnyPgColumn): SQL =>
      user.companyIds === null
        ? sql`true`
        : user.companyIds.length
          ? sql`${col} IN (${sql.join(user.companyIds.map((id) => sql`${id}`), sql`, `)})`
          : sql`false`;

    // CS agents: users whose desk sits under a casino in scope.
    const staffRows = await db
      .select({
        user_id: users.user_id,
        username: users.username,
        full_name: users.full_name,
        status: users.status,
        company_entity_id: entities.parent_entity_id,
      })
      .from(users)
      .innerJoin(entities, eq(entities.entity_id, users.entity_id))
      .where(and(eq(users.role, "cs_agent"), eq(entities.entity_type, "cs"), scope(sql`${entities.parent_entity_id}`)));
    const staffIds = staffRows.map((s) => s.user_id);

    const [tiers, rates, payments, adjustments, penalties, sessions, sharePct] = await Promise.all([
      db.select().from(salaryTiers).where(scope(salaryTiers.company_entity_id)).orderBy(salaryTiers.min_hours, salaryTiers.min_days),
      staffIds.length
        ? db.select().from(staffTierRates).where(inArray(staffTierRates.user_id, staffIds))
        : Promise.resolve([]),
      db.select().from(salaryPayments).where(scope(salaryPayments.company_entity_id)).orderBy(desc(salaryPayments.paid_at)).limit(500),
      // Every pending one, plus recent history.
      db
        .select()
        .from(salaryAdjustments)
        .where(and(scope(salaryAdjustments.company_entity_id), or(isNull(salaryAdjustments.salary_id), sql`${salaryAdjustments.created_at} > now() - interval '120 days'`)))
        .orderBy(desc(salaryAdjustments.occurred_at)),
      db.select().from(staffPenalties).where(scope(staffPenalties.company_entity_id)).orderBy(desc(staffPenalties.occurred_at)).limit(500),
      sessionsFor(db, staffIds, month),
      getSettingNumber(STAFF_PENALTY_SHARE_KEY, 50),
    ]);

    const { startMs, endMs } = monthBounds(month);
    const rateOf = new Map(rates.map((r) => [`${r.user_id}:${r.tier_id}`, r.amount]));
    const staff = staffRows.map((s) => {
      const worked = toWorked(
        rollupSessions(sessions.filter((x) => x.user_id === s.user_id), startMs, endMs),
      );
      const ladder = tiers.filter((t) => t.company_entity_id === s.company_entity_id && t.status === "active");
      const tier = pickTier(ladder, worked.hours, worked.days);
      const rate = tier ? (rateOf.get(`${s.user_id}:${tier.tier_id}`) ?? tier.default_amount) : 0;
      const pending = round2(
        adjustments.filter((a) => a.user_id === s.user_id && a.salary_id === null).reduce((n, a) => n + a.amount, 0),
      );
      const paid = payments.find((p) => p.user_id === s.user_id && p.period_month === month && p.status === "paid");
      return {
        ...s,
        hours: worked.hours,
        days: worked.days,
        tier_id: tier?.tier_id ?? null,
        tier_name: tier?.name ?? null,
        base: tier ? tierPay(tier, rate, worked.hours) : 0,
        pending_adjustments: pending,
        paid_salary_id: paid?.salary_id ?? null,
      };
    });

    return Response.json({
      month,
      staff,
      tiers,
      rates,
      payments,
      adjustments,
      penalties,
      share_pct: sharePct,
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

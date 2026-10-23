import { and, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { entities, salaryAdjustments, salaryPayments, staffLeaves, staffPenalties, users } from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { getSettingNumber, jsonError } from "@/lib/api-helpers";
import {
  attendanceFor,
  baseSalaries,
  dayMarks,
  firstDays,
  isMonth,
  monthBounds,
  monthOf,
  rollupSessions,
  sessionsFor,
  settle,
  toWorked,
  round2,
  STAFF_PENALTY_SHARE_KEY,
} from "@/lib/salary";

/**
 * GET /api/staff-pay?month=YYYY-MM — everything the Salary and Staff Penalty
 * sheets show, for the casinos this user works at.
 *
 * Per CS for the month: base salary, days worked and off (told / untold, free
 * or charged), what attendance does to the pay, what's pending against their
 * next salary, and what it would pay. Plus the payslips, adjustments and
 * penalties and leaves.
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

    const [bases, marks, firsts, payments, adjustments, penalties, leaves, sessions, sharePct] = await Promise.all([
      baseSalaries(db, staffIds),
      dayMarks(db, staffIds, month),
      firstDays(db, staffIds),
      db.select().from(salaryPayments).where(scope(salaryPayments.company_entity_id)).orderBy(desc(salaryPayments.paid_at)).limit(500),
      // Every pending one, plus recent history.
      db
        .select()
        .from(salaryAdjustments)
        .where(and(scope(salaryAdjustments.company_entity_id), or(isNull(salaryAdjustments.salary_id), sql`${salaryAdjustments.created_at} > now() - interval '120 days'`)))
        .orderBy(desc(salaryAdjustments.occurred_at)),
      db.select().from(staffPenalties).where(scope(staffPenalties.company_entity_id)).orderBy(desc(staffPenalties.occurred_at)).limit(500),
      db.select().from(staffLeaves).where(scope(staffLeaves.company_entity_id)).orderBy(desc(staffLeaves.from_day)).limit(500),
      sessionsFor(db, staffIds, month),
      getSettingNumber(STAFF_PENALTY_SHARE_KEY, 50),
    ]);

    const { startMs, endMs } = monthBounds(month);
    const staff = staffRows.map((s) => {
      const worked = toWorked(
        rollupSessions(sessions.filter((x) => x.user_id === s.user_id), startMs, endMs),
      );
      const attendance = attendanceFor(month, worked.daily, marks.get(s.user_id) ?? {}, firsts.get(s.user_id) ?? null);
      const base = bases.get(s.user_id) ?? 0;
      const pendingRows = adjustments.filter((a) => a.user_id === s.user_id && a.salary_id === null);
      const pending = round2(pendingRows.reduce((n, a) => n + a.amount, 0));
      const paid = payments.find((p) => p.user_id === s.user_id && p.period_month === month && p.status === "paid");
      const { net, carried } = settle(base, attendance.amount, pendingRows);
      return {
        ...s,
        base,
        base_set: bases.has(s.user_id),
        // The day rows are for the Day by day dialog, which asks for them.
        attendance: { ...attendance, days: undefined },
        pending_adjustments: pending,
        would_pay: net,
        would_carry: carried,
        paid_salary_id: paid?.salary_id ?? null,
      };
    });

    return Response.json({
      month,
      staff,
      payments,
      adjustments,
      penalties,
      leaves,
      share_pct: sharePct,
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { salaryAdjustments, salaryPayments, staffLeaves, staffPenalties } from "@/db/schema";
import { authErrorResponse, AuthError, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import {
  attendanceFor,
  baseSalaries,
  csCasino,
  dayMarks,
  firstDays,
  inCasinoScope,
  isMonth,
  monthBounds,
  monthOf,
  rollupSessions,
  round2,
  sessionsFor,
  settle,
  toWorked,
} from "@/lib/salary";

/**
 * GET /api/staff-pay/profile?user_id=&month=YYYY-MM — one CS, everything the
 * recorder checks before paying or penalising them: base salary, the month
 * day by day, what's pending against the next salary and what it would pay,
 * and their whole history of leave, payslips, adjustments, advances and
 * penalties.
 * A CS may read their own.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sp = new URL(request.url).searchParams;
    const userId = Number(sp.get("user_id"));
    const monthParam = sp.get("month");
    const month = monthParam && isMonth(monthParam) ? monthParam : monthOf(new Date());
    if (!userId) return jsonError("user_id required");

    const cs = await csCasino(db, userId);
    if (!cs) return jsonError("That account isn't a CS agent with a desk", 404);
    if (userId !== user.user_id && !inCasinoScope(user, cs.casinoId)) {
      throw new AuthError(403, "That CS is outside your organisation");
    }

    const [bases, marks, firsts, sessions, payments, adjustments, penalties, leaves] = await Promise.all([
      baseSalaries(db, [userId]),
      dayMarks(db, [userId], month),
      firstDays(db, [userId]),
      sessionsFor(db, [userId], month),
      db.select().from(salaryPayments).where(eq(salaryPayments.user_id, userId)).orderBy(desc(salaryPayments.period_month)),
      db.select().from(salaryAdjustments).where(eq(salaryAdjustments.user_id, userId)).orderBy(desc(salaryAdjustments.occurred_at)),
      db.select().from(staffPenalties).where(eq(staffPenalties.user_id, userId)).orderBy(desc(staffPenalties.occurred_at)),
      db.select().from(staffLeaves).where(eq(staffLeaves.user_id, userId)).orderBy(desc(staffLeaves.from_day)),
    ]);

    const { startMs, endMs } = monthBounds(month);
    const worked = toWorked(rollupSessions(sessions, startMs, endMs));
    const attendance = attendanceFor(month, worked.daily, marks.get(userId) ?? {}, firsts.get(userId) ?? null);
    const base = bases.get(userId) ?? 0;
    const pendingRows = adjustments.filter((a) => a.salary_id === null);
    const { net, carried } = settle(base, attendance.amount, pendingRows);
    const paid = payments.find((p) => p.period_month === month && p.status === "paid");

    return Response.json({
      cs: {
        user_id: cs.user.user_id,
        username: cs.user.username,
        full_name: cs.user.full_name,
        status: cs.user.status,
        company_entity_id: cs.casinoId,
        telegram_username: cs.user.telegram_username,
        last_login_at: cs.user.last_login_at,
        first_day: firsts.get(userId) ?? null,
      },
      month,
      base,
      base_set: bases.has(userId),
      attendance,
      sessions: sessions.sort((a, b) => a.started_at.localeCompare(b.started_at)),
      pending_adjustments: round2(pendingRows.reduce((n, a) => n + a.amount, 0)),
      would_pay: net,
      would_carry: carried,
      paid_salary_id: paid?.salary_id ?? null,
      payments,
      adjustments,
      penalties,
      leaves,
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

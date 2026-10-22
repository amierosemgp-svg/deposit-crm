import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { salaryPayments, staffDayMarks } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { canManagePay, csCasino, dayMarkSchema, inCasinoScope } from "@/lib/salary";

const MARK_LABEL = { notified: "day off, told", not_notified: "day off, not told" } as const;

/**
 * PUT /api/staff-pay/days — a leader's mark on one CS day, or null to clear it.
 *
 * A paid month is closed: its marks are what the salary was worked out from.
 * Reverse the salary first to change them.
 */
export async function PUT(request: Request) {
  try {
    const user = await requireWriteUser();
    if (!canManagePay(user.role)) throw new AuthError(403, "Days off are marked by a leader or the admin");
    const parsed = dayMarkSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    const body = parsed.data;

    const cs = await csCasino(db, body.user_id);
    if (!cs) return jsonError("That account isn't a CS agent with a desk");
    if (!inCasinoScope(user, cs.casinoId)) throw new AuthError(403, "That CS is outside your organisation");

    const [paid] = await db
      .select({ id: salaryPayments.salary_id })
      .from(salaryPayments)
      .where(
        and(
          eq(salaryPayments.user_id, body.user_id),
          eq(salaryPayments.period_month, body.day.slice(0, 7)),
          eq(salaryPayments.status, "paid"),
        ),
      );
    if (paid) return jsonError(`${body.day.slice(0, 7)} is already paid — reverse the salary to change its days`, 422);

    if (body.mark === null) {
      await db.delete(staffDayMarks).where(and(eq(staffDayMarks.user_id, body.user_id), eq(staffDayMarks.day, body.day)));
    } else {
      const values = {
        mark: body.mark,
        note: body.note || null,
        marked_by_user_id: user.user_id,
        marked_at: new Date().toISOString(),
      };
      await db
        .insert(staffDayMarks)
        .values({ user_id: body.user_id, day: body.day, ...values })
        .onConflictDoUpdate({ target: [staffDayMarks.user_id, staffDayMarks.day], set: values });
    }

    await logActivity({
      category: "payroll",
      action: "salary.day_marked",
      summary: `${cs.user.full_name}, ${body.day}: ${body.mark ? MARK_LABEL[body.mark] : "mark cleared"}${body.note ? ` — ${body.note}` : ""}`,
      actor: user,
      companyEntityId: cs.casinoId,
      targetType: "user",
      targetId: body.user_id,
      targetLabel: cs.user.username,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

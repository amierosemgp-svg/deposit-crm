import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { staffLeaves } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { csCasino, daysBetween, inCasinoScope, LEAVE_KIND_LABEL, leaveSchema, paidMonthsIn } from "@/lib/salary";

/**
 * POST /api/staff-leaves — a CS's leave, From–To. Its days count as off, told
 * or not as recorded; attendance picks it up the next time it's worked out.
 *
 * Any desk user can record one, except against themselves; voiding is a
 * leader's or the admin's call. A paid month is closed — its days are what
 * the salary was worked out from.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = leaveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    const body = parsed.data;

    if (body.user_id === user.user_id && user.role === "cs_agent") {
      throw new AuthError(403, "Ask a colleague or your leader to record your leave");
    }
    const cs = await csCasino(db, body.user_id);
    if (!cs) return jsonError("Leave is for CS agents — pick one");
    if (!inCasinoScope(user, cs.casinoId)) throw new AuthError(403, "That CS is outside your organisation");

    const paid = await paidMonthsIn(db, body.user_id, body.from_day, body.to_day);
    if (paid.length) return jsonError(`${paid.join(", ")} is already paid — reverse that salary to change its days`, 422);

    const [clash] = await db
      .select()
      .from(staffLeaves)
      .where(
        and(
          eq(staffLeaves.user_id, body.user_id),
          eq(staffLeaves.status, "active"),
          lte(staffLeaves.from_day, body.to_day),
          gte(staffLeaves.to_day, body.from_day),
        ),
      );
    if (clash) {
      return jsonError(
        `${cs.user.full_name} already has leave ${clash.from_day}${clash.to_day !== clash.from_day ? ` to ${clash.to_day}` : ""} — void it first`,
        422,
      );
    }

    const [leave] = await db
      .insert(staffLeaves)
      .values({
        user_id: body.user_id,
        company_entity_id: cs.casinoId,
        from_day: body.from_day,
        to_day: body.to_day,
        kind: body.kind,
        notified: body.notified,
        reason: body.reason,
        recorded_by_user_id: user.user_id,
      })
      .returning();

    const days = daysBetween(leave.from_day, leave.to_day).length;
    await logActivity({
      category: "payroll",
      action: "staff_leave.created",
      summary:
        `Leave: ${cs.user.full_name}, ${leave.from_day}${days > 1 ? ` to ${leave.to_day}` : ""} (${days} day${days === 1 ? "" : "s"}) — ` +
        `${LEAVE_KIND_LABEL[leave.kind]}, ${leave.notified ? "told" : "not told"} — ${leave.reason}`,
      actor: user,
      companyEntityId: leave.company_entity_id,
      targetType: "staff_leave",
      targetId: leave.leave_id,
      targetLabel: cs.user.username,
    });
    return Response.json({ leave }, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

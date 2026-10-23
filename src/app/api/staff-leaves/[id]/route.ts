import { eq } from "drizzle-orm";
import { db } from "@/db";
import { staffLeaves, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { canManagePay, inCasinoScope, paidMonthsIn } from "@/lib/salary";

/**
 * DELETE /api/staff-leaves/:id — void a leave recorded in error. The record
 * stays, marked void, and its days go back to whatever the clock says.
 * Refused while a month it touches is paid.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireWriteUser();
    if (!canManagePay(user.role)) throw new AuthError(403, "Only a leader or the admin can void a leave");
    const id = Number((await params).id);

    const [row] = await db.select().from(staffLeaves).where(eq(staffLeaves.leave_id, id));
    if (!row) throw new AuthError(404, "Leave not found");
    if (!inCasinoScope(user, row.company_entity_id)) throw new AuthError(403, "That leave is outside your organisation");
    if (row.status === "void") return jsonError("Already void", 422);
    const paid = await paidMonthsIn(db, row.user_id, row.from_day, row.to_day);
    if (paid.length) return jsonError(`${paid.join(", ")} is already paid — reverse that salary first`, 422);

    const [leave] = await db
      .update(staffLeaves)
      .set({ status: "void", voided_at: new Date().toISOString(), voided_by_user_id: user.user_id })
      .where(eq(staffLeaves.leave_id, id))
      .returning();

    const [staff] = await db.select().from(users).where(eq(users.user_id, leave.user_id));
    await logActivity({
      category: "payroll",
      action: "staff_leave.voided",
      summary: `Leave voided: ${staff?.full_name ?? leave.user_id}, ${leave.from_day}${leave.to_day !== leave.from_day ? ` to ${leave.to_day}` : ""} (${leave.reason})`,
      actor: user,
      companyEntityId: leave.company_entity_id,
      targetType: "staff_leave",
      targetId: leave.leave_id,
      targetLabel: staff?.username ?? null,
    });
    return Response.json({ leave });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

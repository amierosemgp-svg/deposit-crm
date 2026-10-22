import { eq } from "drizzle-orm";
import { db } from "@/db";
import { salaryAdjustments, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { canManagePay, inCasinoScope } from "@/lib/salary";

/**
 * DELETE /api/salary-adjustments/:id — drop a pending bonus, deduction or advance.
 * Once a salary has paid it, it is part of that payslip; reverse the salary.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireWriteUser();
    if (!canManagePay(user.role)) throw new AuthError(403, "Only a leader or the admin can remove an adjustment");
    const id = Number((await params).id);
    const [row] = await db.select().from(salaryAdjustments).where(eq(salaryAdjustments.adjustment_id, id));
    if (!row) return jsonError("Adjustment not found", 404);
    if (!inCasinoScope(user, row.company_entity_id)) throw new AuthError(403, "That adjustment is outside your organisation");
    if (row.salary_id != null) return jsonError("Already paid in a salary — reverse that salary first", 422);
    if (row.kind === "penalty") return jsonError("Void the staff penalty instead", 422);
    if (row.kind === "carry") return jsonError("A carry goes when the salary that made it is reversed", 422);

    await db.delete(salaryAdjustments).where(eq(salaryAdjustments.adjustment_id, id));
    const [staff] = await db.select().from(users).where(eq(users.user_id, row.user_id));
    await logActivity({
      category: "payroll",
      action: "salary_adjustment.removed",
      summary: `Removed ${row.kind} of RM ${Math.abs(row.amount).toFixed(2)} from ${staff?.full_name ?? row.user_id}'s next salary — ${row.reason}`,
      actor: user,
      companyEntityId: row.company_entity_id,
      targetType: "salary_adjustment",
      targetId: row.adjustment_id,
      targetLabel: staff?.username ?? null,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

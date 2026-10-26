import { db } from "@/db";
import { staffBaseSalaries } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { baseSalarySchema, canManagePay, csCasino, inCasinoScope } from "@/lib/salary";

/**
 * PUT /api/staff-pay/base — set a CS's monthly base salary.
 *
 * Read at pay time, so it applies to every month not yet paid; a paid salary
 * keeps the base it was paid with.
 */
export async function PUT(request: Request) {
  try {
    const user = await requireWriteUser();
    if (!canManagePay(user.role)) throw new AuthError(403, "Base salaries are set by a leader or the admin");
    const parsed = baseSalarySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    const body = parsed.data;

    const cs = await csCasino(db, body.user_id);
    if (!cs) return jsonError("That account isn't a CS agent with a desk");
    if (!inCasinoScope(user, cs.casinoId)) throw new AuthError(403, "That CS is outside your organisation");

    const values = { amount: body.amount, updated_by_user_id: user.user_id, updated_at: new Date().toISOString() };
    const [row] = await db
      .insert(staffBaseSalaries)
      .values({ user_id: body.user_id, ...values })
      .onConflictDoUpdate({ target: staffBaseSalaries.user_id, set: values })
      .returning();

    await logActivity({
      category: "payroll",
      action: "salary.base_set",
      summary: `Base salary for ${cs.user.full_name} set to RM ${body.amount.toFixed(2)}`,
      actor: user,
      companyEntityId: cs.casinoId,
      targetType: "user",
      targetId: body.user_id,
      targetLabel: cs.user.username,
    });
    return Response.json({ base: row });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

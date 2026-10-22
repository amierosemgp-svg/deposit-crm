import { z } from "zod";
import { db } from "@/db";
import { salaryAdjustments } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { canManagePay, csCasino, inCasinoScope } from "@/lib/salary";

const createSchema = z.object({
  user_id: z.number().int().positive(),
  kind: z.enum(["bonus", "deduction", "advance"]),
  // Always positive here; the kind says which way it goes.
  amount: z.number().positive(),
  reason: z.string().trim().min(1).max(200),
  occurred_at: z.string().min(1),
});

/**
 * POST /api/salary-adjustments — a bonus, a deduction or an advance on a CS's
 * next salary. An advance is salary already handed over: it comes off after
 * everything else, and is the only thing that can take a salary below zero.
 *
 * Penalties and carries are not keyed here: a penalty comes from a staff
 * penalty record, a carry from a salary that couldn't cover its deductions.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (!canManagePay(user.role)) throw new AuthError(403, "Bonuses, deductions and advances are set by a leader or the admin");
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    const body = parsed.data;

    const cs = await csCasino(db, body.user_id);
    if (!cs) return jsonError("That account isn't a CS agent with a desk");
    if (!inCasinoScope(user, cs.casinoId)) throw new AuthError(403, "That CS is outside your organisation");
    if (Number.isNaN(new Date(body.occurred_at).getTime())) return jsonError("Bad date");

    const [created] = await db
      .insert(salaryAdjustments)
      .values({
        user_id: body.user_id,
        company_entity_id: cs.casinoId,
        kind: body.kind,
        amount: body.kind === "bonus" ? body.amount : -body.amount,
        reason: body.reason,
        occurred_at: new Date(body.occurred_at).toISOString(),
        created_by_user_id: user.user_id,
      })
      .returning();

    await logActivity({
      category: "payroll",
      action: `salary_adjustment.${body.kind}`,
      summary: `${{ bonus: "Bonus", deduction: "Deduction", advance: "Advance" }[body.kind]} of RM ${body.amount.toFixed(2)} for ${cs.user.full_name}'s next salary — ${body.reason}`,
      actor: user,
      companyEntityId: cs.casinoId,
      targetType: "salary_adjustment",
      targetId: created.adjustment_id,
      targetLabel: cs.user.username,
    });
    return Response.json({ adjustment: created }, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

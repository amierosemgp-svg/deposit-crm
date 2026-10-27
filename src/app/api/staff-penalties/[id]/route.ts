import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { salaryAdjustments, staffPenalties, transactions, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { canManagePay, inCasinoScope } from "@/lib/salary";

class Refusal extends Error {}

/**
 * DELETE /api/staff-penalties/:id — void a penalty recorded in error.
 *
 * Only while it is still pending: once a salary has deducted it, reversing
 * that salary is what puts it back in play.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireWriteUser();
    if (!canManagePay(user.role)) throw new AuthError(403, "Only a leader or the admin can void a penalty");
    const id = Number((await params).id);

    const penalty = await db.transaction(async (txn) => {
      const [row] = await txn.select().from(staffPenalties).where(eq(staffPenalties.penalty_id, id)).for("update");
      if (!row) throw new AuthError(404, "Penalty not found");
      if (!inCasinoScope(user, row.company_entity_id)) throw new AuthError(403, "That penalty is outside your organisation");
      if (row.status === "void") throw new Refusal("Already void");
      const [adj] = await txn
        .select()
        .from(salaryAdjustments)
        .where(eq(salaryAdjustments.penalty_id, row.penalty_id))
        .for("update");
      if (adj?.salary_id != null) {
        throw new Refusal("Already deducted from a salary — reverse that salary first");
      }
      if (adj) await txn.delete(salaryAdjustments).where(eq(salaryAdjustments.adjustment_id, adj.adjustment_id));
      // Its Staff Error bonus goes with it: a void penalty lost nothing.
      await txn
        .delete(transactions)
        .where(
          and(
            eq(transactions.type, "game_topup"),
            sql`${transactions.details}->>'action' = 'staff_error'`,
            sql`(${transactions.details}->>'penalty_id')::int = ${row.penalty_id}`,
          ),
        );
      const [updated] = await txn
        .update(staffPenalties)
        .set({ status: "void", voided_at: new Date().toISOString(), voided_by_user_id: user.user_id })
        .where(eq(staffPenalties.penalty_id, row.penalty_id))
        .returning();
      return updated;
    });

    const [staff] = await db.select().from(users).where(eq(users.user_id, penalty.user_id));
    await logActivity({
      category: "payroll",
      action: "staff_penalty.voided",
      summary: `Staff penalty voided: ${staff?.full_name ?? penalty.user_id} — RM ${penalty.amount.toFixed(2)} (${penalty.reason})`,
      actor: user,
      companyEntityId: penalty.company_entity_id,
      targetType: "staff_penalty",
      targetId: penalty.penalty_id,
      targetLabel: staff?.username ?? null,
    });
    return Response.json({ penalty });
  } catch (e) {
    if (e instanceof Refusal) return jsonError(e.message, 422);
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

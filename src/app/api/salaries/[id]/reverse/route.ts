import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, salaryAdjustments, salaryPayments, transactions, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { moveBankBalance } from "@/lib/bank-balance";
import { canManagePay, inCasinoScope } from "@/lib/salary";

class Refusal extends Error {}

/**
 * POST /api/salaries/:id/reverse — undo a salary paid in error.
 *
 * The money goes back on the account it left, and every adjustment it claimed
 * is pending again, so the corrected salary picks them up. A shortfall it
 * carried forward is withdrawn — unless a later salary already deducted it, in
 * which case that one has to be reversed first.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireWriteUser();
    if (!canManagePay(user.role)) throw new AuthError(403, "Only a leader or the admin can reverse a salary");
    const id = Number((await params).id);

    const salary = await db.transaction(async (txn) => {
      const [row] = await txn.select().from(salaryPayments).where(eq(salaryPayments.salary_id, id)).for("update");
      if (!row) throw new AuthError(404, "Salary not found");
      if (!inCasinoScope(user, row.company_entity_id)) throw new AuthError(403, "That salary is outside your organisation");
      if (row.status !== "paid") throw new Refusal("Already reversed");

      const [carry] = await txn
        .select()
        .from(salaryAdjustments)
        .where(eq(salaryAdjustments.carried_from_salary_id, row.salary_id))
        .for("update");
      if (carry?.salary_id != null) {
        throw new Refusal("Its shortfall was already deducted from a later salary — reverse that one first");
      }
      if (carry) await txn.delete(salaryAdjustments).where(eq(salaryAdjustments.adjustment_id, carry.adjustment_id));

      await txn
        .update(salaryAdjustments)
        .set({ salary_id: null })
        .where(and(eq(salaryAdjustments.salary_id, row.salary_id), isNotNull(salaryAdjustments.salary_id)));

      if (row.paid_from_account_id != null && row.net_amount > 0) {
        const balance = await moveBankBalance(txn, { accountId: row.paid_from_account_id, delta: row.net_amount });
        const [account] = await txn.select().from(bankAccounts).where(eq(bankAccounts.account_id, row.paid_from_account_id));
        await txn.insert(transactions).values({
          entity_id: account?.entity_id ?? row.company_entity_id,
          type: "salary",
          amount: -row.net_amount,
          reference_id: row.salary_id,
          user_id: user.user_id,
          details: {
            action: "salary_reversed",
            staff_user_id: row.user_id,
            month: row.period_month,
            account_id: row.paid_from_account_id,
            bank: account ? `${account.bank_name} ${account.account_number}` : null,
            balance_after: balance,
          },
        });
      }

      const [updated] = await txn
        .update(salaryPayments)
        .set({ status: "reversed", reversed_at: new Date().toISOString(), reversed_by_user_id: user.user_id })
        .where(eq(salaryPayments.salary_id, row.salary_id))
        .returning();
      return updated;
    });

    const [staff] = await db.select().from(users).where(eq(users.user_id, salary.user_id));
    await logActivity({
      category: "payroll",
      action: "salary.reversed",
      summary: `Salary reversed: ${staff?.full_name ?? `user ${salary.user_id}`}, ${salary.period_month} — RM ${salary.net_amount.toFixed(2)} back to the account; its adjustments are pending again`,
      actor: user,
      companyEntityId: salary.company_entity_id,
      targetType: "salary",
      targetId: salary.salary_id,
      targetLabel: `${staff?.full_name ?? salary.user_id} ${salary.period_month}`,
    });
    return Response.json({ salary });
  } catch (e) {
    if (e instanceof Refusal) return jsonError(e.message, 422);
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

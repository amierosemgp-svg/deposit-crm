import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, entities, salaryAdjustments, salaryPayments, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { isUniqueViolation, jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { InsufficientBankBalanceError, moveBankBalance } from "@/lib/bank-balance";
import { canManagePay, computeSalary, inCasinoScope, isMonth } from "@/lib/salary";

const createSchema = z
  .object({
    user_id: z.number().int().positive(),
    month: z.string().refine(isMonth, "month must be YYYY-MM"),
    paid_from_account_id: z.number().int().positive().nullable().optional(),
    paid_from_cash_entity_id: z.number().int().positive().nullable().optional(),
    // What the person saw when they pressed Pay. If the server's figure has
    // moved since (a penalty landed, another hour logged), it refuses rather
    // than pay an amount nobody looked at.
    expected_net: z.number().min(0),
    notes: z.string().max(500).optional(),
  })
  .refine((v) => !(v.paid_from_account_id && v.paid_from_cash_entity_id), {
    message: "A salary is paid from a bank account or from cash, not both",
  });

class Refusal extends Error {}

/**
 * POST /api/salaries — pay a CS their month.
 *
 * Nothing about the amount is typed. The base is this person's; days worked
 * and off come from the work clock and the leader's day marks; and every
 * pending adjustment — penalties and advances included — is claimed by this
 * salary in the same transaction that takes the money out of the account.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (!canManagePay(user.role)) throw new AuthError(403, "Salaries are paid by a leader or the admin");
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    const body = parsed.data;

    // Same rule as expenses: a leader's own cash is the admin's book.
    if (body.paid_from_cash_entity_id != null && user.role !== "super_admin") {
      throw new AuthError(403, "Only admins record payments from a leader's cash");
    }
    if (body.paid_from_account_id != null) {
      const [account] = await db.select().from(bankAccounts).where(eq(bankAccounts.account_id, body.paid_from_account_id));
      if (!account) return jsonError("Bank account not found", 404);
      if (user.ownedEntityIds !== null && !user.ownedEntityIds.includes(account.entity_id)) {
        throw new AuthError(403, "That bank account is outside your organisation");
      }
    }
    if (body.paid_from_cash_entity_id != null) {
      const [leader] = await db.select().from(entities).where(eq(entities.entity_id, body.paid_from_cash_entity_id));
      if (!leader || leader.entity_type !== "leader") return jsonError("Cash is held by a leader — pick a leader");
      if (user.ownedEntityIds !== null && !user.ownedEntityIds.includes(leader.entity_id)) {
        throw new AuthError(403, "That leader is outside your organisation");
      }
    }

    const result = await db.transaction(async (txn) => {
      // Said plainly, before the figures: paying it again would otherwise read
      // as "the salary changed", its adjustments having gone to the first one.
      const [already] = await txn
        .select({ id: salaryPayments.salary_id })
        .from(salaryPayments)
        .where(
          and(
            eq(salaryPayments.user_id, body.user_id),
            eq(salaryPayments.period_month, body.month),
            eq(salaryPayments.status, "paid"),
          ),
        );
      if (already) throw new Refusal(`${body.month} is already paid for this CS — reverse it first to pay again`);

      const p = await computeSalary(txn, body.user_id, body.month, { lock: true });
      if ("error" in p) throw new Refusal(p.error);
      // Days off decide the month, so it can only be paid once it is over.
      // Money needed before then is an advance.
      if (!p.attendance.complete) {
        throw new Refusal(`${body.month} isn't over yet — pay it from the 1st of next month, or record an advance`);
      }
      if (!inCasinoScope(user, p.company_entity_id)) {
        throw new AuthError(403, "That CS is outside your organisation");
      }
      if (Math.abs(p.net - body.expected_net) > 0.004) {
        throw new Refusal(
          `The salary changed since you looked — it is now RM ${p.net.toFixed(2)}. Check it and pay again.`,
        );
      }
      if (p.net > 0 && body.paid_from_account_id == null && body.paid_from_cash_entity_id == null) {
        throw new Refusal("Say what it's paid from — a bank account or a leader's cash");
      }

      const [salary] = await txn
        .insert(salaryPayments)
        .values({
          user_id: p.user_id,
          company_entity_id: p.company_entity_id,
          period_month: p.month,
          hours_worked: p.worked.hours,
          days_worked: p.worked.days,
          base_amount: p.base,
          attendance_amount: p.attendance.amount,
          // The summary, not the 31 day rows — those are rebuilt from the
          // clock and the marks whenever someone asks.
          attendance: { ...p.attendance, days: undefined, waived: p.waived },
          adjustments_total: p.adjustments_total,
          net_amount: p.net,
          carried_forward: p.carried,
          // A salary of 0 moved no money from anywhere.
          paid_from_account_id: p.net > 0 ? (body.paid_from_account_id ?? null) : null,
          paid_from_cash_entity_id: p.net > 0 ? (body.paid_from_cash_entity_id ?? null) : null,
          notes: body.notes?.trim() || null,
          recorded_by_user_id: user.user_id,
        })
        .returning();

      if (p.adjustments.length) {
        await txn
          .update(salaryAdjustments)
          .set({ salary_id: salary.salary_id })
          .where(inArray(salaryAdjustments.adjustment_id, p.adjustments.map((a) => a.adjustment_id)));
      }
      if (p.carried > 0) {
        await txn.insert(salaryAdjustments).values({
          user_id: p.user_id,
          company_entity_id: p.company_entity_id,
          kind: "carry",
          amount: -p.carried,
          reason: `Advance not covered by the ${p.month} salary`,
          occurred_at: new Date().toISOString(),
          carried_from_salary_id: salary.salary_id,
          created_by_user_id: user.user_id,
        });
      }

      if (salary.paid_from_account_id != null) {
        const balance = await moveBankBalance(txn, { accountId: salary.paid_from_account_id, delta: -p.net });
        const [account] = await txn.select().from(bankAccounts).where(eq(bankAccounts.account_id, salary.paid_from_account_id));
        await txn.insert(transactions).values({
          entity_id: account?.entity_id ?? p.company_entity_id,
          type: "salary",
          amount: p.net,
          reference_id: salary.salary_id,
          user_id: user.user_id,
          details: {
            action: "salary_paid",
            staff_user_id: p.user_id,
            staff_name: p.full_name,
            month: p.month,
            account_id: salary.paid_from_account_id,
            bank: account ? `${account.bank_name} ${account.account_number}` : null,
            balance_after: balance,
          },
        });
      }
      return { salary, preview: p };
    });

    const { salary, preview } = result;
    await logActivity({
      category: "payroll",
      action: "salary.paid",
      summary:
        `Salary paid: ${preview.full_name}, ${preview.month} — RM ${salary.net_amount.toFixed(2)} ` +
        `(${preview.attendance.worked} days worked, ${preview.attendance.off} off, attendance ${preview.attendance.amount >= 0 ? "+" : ""}${preview.attendance.amount}` +
        `${preview.adjustments_total ? `, adjustments ${preview.adjustments_total.toFixed(2)}` : ""})` +
        (salary.carried_forward ? `; RM ${salary.carried_forward.toFixed(2)} carried to next month` : ""),
      actor: user,
      companyEntityId: salary.company_entity_id,
      targetType: "salary",
      targetId: salary.salary_id,
      targetLabel: `${preview.full_name} ${preview.month}`,
      context: {
        net: salary.net_amount,
        base: salary.base_amount,
        attendance: salary.attendance_amount,
        adjustments: salary.adjustments_total,
      },
    });

    return Response.json({ salary }, { status: 201 });
  } catch (e) {
    if (e instanceof Refusal) return jsonError(e.message, 422);
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    if (isUniqueViolation(e)) return jsonError("That month is already paid for this CS — reverse it first to pay again", 409);
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

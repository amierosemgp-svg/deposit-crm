import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, entities, expenses } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { EXPENSE_CATEGORIES } from "@/lib/types";

const createSchema = z
  .object({
    expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    category: z.enum(EXPENSE_CATEGORIES),
    description: z.string().min(1).max(200),
    amount: z.number().positive(),
    company_entity_id: z.number().int().positive().nullable().optional(),
    notes: z.string().optional(),
    // What it was paid out of: one of our accounts, or a leader's own cash.
    // Omit both to leave it unrecorded, as every row written before this.
    paid_from_account_id: z.number().int().positive().nullable().optional(),
    paid_from_cash_entity_id: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => !(v.paid_from_account_id && v.paid_from_cash_entity_id), {
    message: "An expense is paid from a bank account or from cash, not both",
    path: ["paid_from_account_id"],
  });

/** POST /api/expenses — admins record operational expenses. */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (user.role !== "super_admin") {
      throw new AuthError(403, "Only admins record expenses");
    }
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    }
    const body = parsed.data;

    if (body.company_entity_id != null) {
      const [company] = await db
        .select()
        .from(entities)
        .where(eq(entities.entity_id, body.company_entity_id));
      if (!company || company.entity_type !== "company") {
        return jsonError(`Entity ${body.company_entity_id} is not a company`);
      }
    }

    // A named account has to exist and be one this admin can see; cash has to
    // come from an actual leader, or "paid from cash" says nothing settleable.
    if (body.paid_from_account_id != null) {
      const [account] = await db
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, body.paid_from_account_id));
      if (!account) return jsonError("Bank account not found", 404);
      if (
        user.ownedEntityIds !== null &&
        !user.ownedEntityIds.includes(account.entity_id)
      ) {
        throw new AuthError(403, "That bank account is outside your organisation");
      }
    }
    if (body.paid_from_cash_entity_id != null) {
      const [leader] = await db
        .select()
        .from(entities)
        .where(eq(entities.entity_id, body.paid_from_cash_entity_id));
      if (!leader) return jsonError("Leader not found", 404);
      if (leader.entity_type !== "leader") {
        return jsonError("Cash is held by a leader — pick a leader, not a company");
      }
      if (
        user.ownedEntityIds !== null &&
        !user.ownedEntityIds.includes(leader.entity_id)
      ) {
        throw new AuthError(403, "That leader is outside your organisation");
      }
    }

    const [created] = await db
      .insert(expenses)
      .values({
        ...body,
        company_entity_id: body.company_entity_id ?? null,
        paid_from_account_id: body.paid_from_account_id ?? null,
        paid_from_cash_entity_id: body.paid_from_cash_entity_id ?? null,
        recorded_by_user_id: user.user_id,
      })
      .returning();

    await logActivity({
      category: "expense",
      action: "expense.created",
      summary: `Expense recorded: ${created.description} — RM ${created.amount.toFixed(2)} (${created.category})`,
      actor: user,
      companyEntityId: created.company_entity_id,
      targetType: "expense",
      targetId: created.expense_id,
      targetLabel: created.description,
      context: { amount: created.amount, category: created.category },
    });

    return Response.json({ expense: created }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

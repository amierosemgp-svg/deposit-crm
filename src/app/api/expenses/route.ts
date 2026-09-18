import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, entities, expenses, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { InsufficientBankBalanceError, moveBankBalance } from "@/lib/bank-balance";
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

/**
 * Categories anyone who can write may record.
 *
 * The rest of the book — salaries, rent, what the business pays out — stays
 * the admin's. Bank charges are different in kind: the bank takes them out of
 * a company account whether anyone is looking or not, and the balance does not
 * tally again until somebody records it. Making the desk wait for an admin to
 * do that is how the figure stays wrong.
 */
const OPEN_CATEGORIES = new Set(["bank_charge"]);

/** POST /api/expenses — operational expenses; bank charges by anyone. */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const isAdmin = user.role === "super_admin";
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    }
    const body = parsed.data;

    if (!isAdmin) {
      if (!OPEN_CATEGORIES.has(body.category)) {
        throw new AuthError(
          403,
          `Only admins record ${body.category.replace(/_/g, " ")} — you can record bank charges`,
        );
      }
      // Theirs to record means theirs to account for: a company they work for,
      // and an account that company actually holds.
      if (
        body.company_entity_id == null ||
        (user.companyIds !== null && !user.companyIds.includes(body.company_entity_id))
      ) {
        throw new AuthError(403, "Record the charge against one of your own companies");
      }
      if (body.paid_from_account_id == null) {
        throw new AuthError(422, "Say which bank account the charge came out of");
      }
      if (body.paid_from_cash_entity_id != null) {
        throw new AuthError(403, "Only admins record cash payments");
      }
    }

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

    /**
     * Recording the expense and taking the money out of the account are one
     * step. An expense that names the account it was paid from and then leaves
     * that balance untouched is how the CRM ends up richer than the bank —
     * which is the whole reason bank charges could not be recorded here.
     *
     * Cash out of a leader's own pocket moves no company balance, so only the
     * bank-account case books anything.
     */
    const created = await db.transaction(async (txn) => {
      const [row] = await txn
        .insert(expenses)
        .values({
          ...body,
          company_entity_id: body.company_entity_id ?? null,
          paid_from_account_id: body.paid_from_account_id ?? null,
          paid_from_cash_entity_id: body.paid_from_cash_entity_id ?? null,
          recorded_by_user_id: user.user_id,
        })
        .returning();

      if (row.paid_from_account_id != null) {
        const balance = await moveBankBalance(txn, {
          accountId: row.paid_from_account_id,
          delta: -row.amount,
        });
        const [account] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, row.paid_from_account_id));
        await txn.insert(transactions).values({
          entity_id: account?.entity_id ?? row.company_entity_id,
          type: "expense",
          amount: row.amount,
          reference_id: row.expense_id,
          user_id: user.user_id,
          details: {
            action: "expense_paid",
            category: row.category,
            description: row.description,
            account_id: row.paid_from_account_id,
            bank: account ? `${account.bank_name} ${account.account_number}` : null,
            balance_after: balance,
          },
        });
      }
      return row;
    });

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
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

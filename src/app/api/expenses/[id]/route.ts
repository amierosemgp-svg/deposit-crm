import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, expenses, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { moveBankBalance } from "@/lib/bank-balance";

/**
 * DELETE /api/expenses/:id — remove a mistaken entry, and put the money back.
 *
 * Admins delete anything. Anyone else may undo a bank charge they recorded
 * themselves: they can enter those, so leaving them unable to fix a mistyped
 * one would just mean an admin doing it later from a worse description.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const isAdmin = user.role === "super_admin";
    const { id } = await params;

    if (!isAdmin) {
      const [row] = await db
        .select()
        .from(expenses)
        .where(eq(expenses.expense_id, Number(id)));
      if (!row) return jsonError("Expense not found", 404);
      if (row.category !== "bank_charge" || row.recorded_by_user_id !== user.user_id) {
        throw new AuthError(403, "Only admins remove that one");
      }
    }

    // Deleting an expense that was paid from an account puts the money back,
    // in the same step. Otherwise removing a mistyped row would leave the
    // balance short by it for good.
    const deleted = await db.transaction(async (txn) => {
      const [row] = await txn
        .delete(expenses)
        .where(eq(expenses.expense_id, Number(id)))
        .returning();
      if (!row) return null;
      if (row.paid_from_account_id != null) {
        const balance = await moveBankBalance(txn, {
          accountId: row.paid_from_account_id,
          delta: row.amount,
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
            action: "expense_deleted",
            category: row.category,
            description: row.description,
            account_id: row.paid_from_account_id,
            balance_after: balance,
          },
        });
      }
      return row;
    });
    if (!deleted) return jsonError("Expense not found", 404);

    await logActivity({
      category: "expense",
      action: "expense.deleted",
      summary: `Expense deleted: ${deleted.description} — RM ${deleted.amount.toFixed(2)} (${deleted.category})`,
      actor: user,
      companyEntityId: deleted.company_entity_id,
      targetType: "expense",
      targetId: deleted.expense_id,
      targetLabel: deleted.description,
      context: { amount: deleted.amount, category: deleted.category },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

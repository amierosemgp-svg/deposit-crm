import { eq } from "drizzle-orm";
import { db } from "@/db";
import { expenses } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";

/** DELETE /api/expenses/:id — admins remove a mistaken expense entry. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    if (user.role !== "super_admin") {
      throw new AuthError(403, "Only admins manage expenses");
    }
    const { id } = await params;
    const [deleted] = await db
      .delete(expenses)
      .where(eq(expenses.expense_id, Number(id)))
      .returning();
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

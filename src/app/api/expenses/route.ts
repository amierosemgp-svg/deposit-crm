import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, expenses } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { EXPENSE_CATEGORIES } from "@/lib/types";

const createSchema = z.object({
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().min(1).max(200),
  amount: z.number().positive(),
  company_entity_id: z.number().int().positive().nullable().optional(),
  notes: z.string().optional(),
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

    const [created] = await db
      .insert(expenses)
      .values({
        ...body,
        company_entity_id: body.company_entity_id ?? null,
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

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bonusPlans } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { isUniqueViolation, jsonError } from "@/lib/api-helpers";
import { assertPlanScope, planUsageCount } from "@/lib/bonus";

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  type: z.enum(["welcome", "recurring", "rebate"]).optional(),
  period: z.enum(["daily", "weekly", "monthly"]).nullable().optional(),
  percentage: z.number().min(0.01).max(500).optional(),
  min_deposit: z.number().min(0).max(1_000_000).optional(),
  min_loss: z.number().min(0).max(1_000_000).optional(),
  company_entity_id: z.number().int().positive().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  notes: z.string().max(500).nullable().optional(),
});

async function loadScoped(
  user: Awaited<ReturnType<typeof requireWriteUser>>,
  planId: number,
) {
  const [row] = await db
    .select()
    .from(bonusPlans)
    .where(eq(bonusPlans.plan_id, planId));
  if (!row) throw new AuthError(404, "Bonus not found");
  await assertPlanScope(user, row.company_entity_id);
  return row;
}

/**
 * PATCH /api/bonus-plans/:id — edit a bonus.
 *
 * Edits are forward-looking only: deposits snapshot the percentage and amount
 * they were given, so raising a rate never re-prices what has already gone out.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const planId = Number(id);
    const existing = await loadScoped(user, planId);

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const body = parsed.data;

    // Moving a plan between scopes is the one edit that can hand a leader
    // someone else's plan, so the destination is checked as well as the source.
    if (body.company_entity_id !== undefined) {
      await assertPlanScope(user, body.company_entity_id);
    }

    const type = body.type ?? existing.type;
    const period =
      body.period !== undefined ? body.period : existing.period;
    if (type === "welcome" ? !!period : !period) {
      return jsonError(
        "Daily/weekly/monthly bonuses and rebates need a period; a welcome bonus must not have one",
      );
    }

    const [updated] = await db
      .update(bonusPlans)
      .set({
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        type,
        period: type === "welcome" ? null : period,
        ...(body.percentage !== undefined ? { percentage: body.percentage } : {}),
        ...(body.min_deposit !== undefined ? { min_deposit: body.min_deposit } : {}),
        min_loss:
          type === "rebate" ? (body.min_loss ?? existing.min_loss) : 0,
        ...(body.company_entity_id !== undefined
          ? { company_entity_id: body.company_entity_id }
          : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        updated_at: new Date().toISOString(),
      })
      .where(eq(bonusPlans.plan_id, planId))
      .returning();

    return Response.json({ plan: updated });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return jsonError("A bonus with that name already exists", 409);
    }
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/**
 * DELETE /api/bonus-plans/:id — remove a bonus nobody has used.
 *
 * A plan that deposits point at is history, not configuration: deleting it
 * would orphan the rows that record why those players got what they got.
 * Switching it off takes it out of the dropdown and leaves the record intact.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const planId = Number(id);
    await loadScoped(user, planId);

    const used = await planUsageCount(planId);
    if (used > 0) {
      return jsonError(
        `${used} deposit${used === 1 ? " has" : "s have"} used this bonus — switch it off instead of deleting it`,
        422,
      );
    }

    await db.delete(bonusPlans).where(eq(bonusPlans.plan_id, planId));
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

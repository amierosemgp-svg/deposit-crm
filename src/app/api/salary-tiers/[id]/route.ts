import { eq } from "drizzle-orm";
import { db } from "@/db";
import { salaryTiers } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { diffFields, describeChanges, logActivity } from "@/lib/activity-log";
import { inCasinoScope, tierSchema } from "@/lib/salary";

const patchSchema = tierSchema.omit({ company_entity_id: true }).partial();

async function load(id: number, user: { companyIds: number[] | null }) {
  const [tier] = await db.select().from(salaryTiers).where(eq(salaryTiers.tier_id, id));
  if (!tier) throw new AuthError(404, "Tier not found");
  if (!inCasinoScope(user, tier.company_entity_id)) {
    throw new AuthError(403, "That casino is outside your organisation");
  }
  return tier;
}

/**
 * PATCH /api/salary-tiers/:id — change a rung. Salaries already paid keep the
 * figures they were paid on; this only moves the next one.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireWriteUser();
    const tier = await load(Number((await params).id), user);
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);

    const [updated] = await db
      .update(salaryTiers)
      .set({ ...parsed.data, updated_at: new Date().toISOString() })
      .where(eq(salaryTiers.tier_id, tier.tier_id))
      .returning();

    const changes = diffFields(tier, parsed.data);
    if (changes.length) {
      await logActivity({
        category: "payroll",
        action: "salary_tier.updated",
        summary: `Salary tier "${updated.name}" changed: ${describeChanges(changes)}`,
        actor: user,
        companyEntityId: updated.company_entity_id,
        targetType: "salary_tier",
        targetId: updated.tier_id,
        targetLabel: updated.name,
        changes,
      });
    }
    return Response.json({ tier: updated });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/** DELETE /api/salary-tiers/:id — retire a rung. Kept, because past salaries name it. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireWriteUser();
    const tier = await load(Number((await params).id), user);
    await db
      .update(salaryTiers)
      .set({ status: "inactive", updated_at: new Date().toISOString() })
      .where(eq(salaryTiers.tier_id, tier.tier_id));
    await logActivity({
      category: "payroll",
      action: "salary_tier.retired",
      summary: `Salary tier "${tier.name}" removed`,
      actor: user,
      companyEntityId: tier.company_entity_id,
      targetType: "salary_tier",
      targetId: tier.tier_id,
      targetLabel: tier.name,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

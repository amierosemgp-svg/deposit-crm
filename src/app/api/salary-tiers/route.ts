import { eq } from "drizzle-orm";
import { db } from "@/db";
import { entities, salaryTiers } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { inCasinoScope, tierSchema } from "@/lib/salary";


/**
 * POST /api/salary-tiers — add a rung to a casino's salary ladder.
 *
 * Open to every role that can write: the desk keeps its own ladder.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = tierSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    const body = parsed.data;

    const [casino] = await db.select().from(entities).where(eq(entities.entity_id, body.company_entity_id));
    if (!casino || casino.entity_type !== "company") return jsonError("Pick a casino");
    if (!inCasinoScope(user, casino.entity_id)) {
      throw new AuthError(403, "That casino is outside your organisation");
    }

    const [created] = await db
      .insert(salaryTiers)
      .values({ ...body, created_by_user_id: user.user_id })
      .returning();

    await logActivity({
      category: "payroll",
      action: "salary_tier.created",
      summary: `Salary tier "${created.name}" added at ${casino.name}: ${created.min_hours}h / ${created.min_days} days → RM ${created.default_amount.toFixed(2)}${created.basis === "hourly" ? " per hour" : ""}`,
      actor: user,
      companyEntityId: casino.entity_id,
      targetType: "salary_tier",
      targetId: created.tier_id,
      targetLabel: created.name,
    });
    return Response.json({ tier: created }, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

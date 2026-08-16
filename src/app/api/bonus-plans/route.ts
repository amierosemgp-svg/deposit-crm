import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bonusPlans, entities } from "@/db/schema";
import { authErrorResponse, requireUser, requireWriteUser } from "@/lib/auth";
import { isUniqueViolation, jsonError } from "@/lib/api-helpers";
import { assertPlanScope } from "@/lib/bonus";
import { logActivity } from "@/lib/activity-log";

const planSchema = z
  .object({
    name: z.string().min(1).max(80),
    type: z.enum(["welcome", "recurring", "rebate"]),
    period: z.enum(["daily", "weekly", "monthly"]).nullable().optional(),
    percentage: z.number().min(0.01).max(500),
    min_deposit: z.number().min(0).max(1_000_000).default(0),
    min_loss: z.number().min(0).max(1_000_000).default(0),
    company_entity_id: z.number().int().positive().nullable().optional(),
    status: z.enum(["active", "inactive"]).default("active"),
    notes: z.string().max(500).nullable().optional(),
  })
  // A welcome bonus is claimed once ever, so a period would be a lie; the other
  // two are defined by theirs. Mirrors the CHECK constraint on the table.
  .refine((v) => (v.type === "welcome" ? !v.period : !!v.period), {
    message:
      "Daily/weekly/monthly bonuses and rebates need a period; a welcome bonus must not have one",
    path: ["period"],
  });

/** GET /api/bonus-plans — the full catalogue, for the admin screen. */
export async function GET() {
  try {
    await requireUser();
    const plans = await db
      .select()
      .from(bonusPlans)
      .orderBy(asc(bonusPlans.type), asc(bonusPlans.name));
    return Response.json({ bonusPlans: plans });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/** POST /api/bonus-plans — add a bonus to the catalogue. */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = planSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const body = parsed.data;
    const companyId = body.company_entity_id ?? null;
    await assertPlanScope(user, companyId);

    if (companyId !== null) {
      const [company] = await db
        .select()
        .from(entities)
        .where(eq(entities.entity_id, companyId));
      if (!company) return jsonError("Company not found", 404);
      if (company.entity_type !== "company") {
        return jsonError("A bonus is scoped to a company, or to nobody at all");
      }
    }

    const [created] = await db
      .insert(bonusPlans)
      .values({
        name: body.name.trim(),
        type: body.type,
        period: body.type === "welcome" ? null : body.period!,
        percentage: body.percentage,
        min_deposit: body.min_deposit,
        // A minimum loss only means something for a rebate; storing one on the
        // other types would leave a dead number for the next reader to puzzle over.
        min_loss: body.type === "rebate" ? body.min_loss : 0,
        company_entity_id: companyId,
        status: body.status,
        notes: body.notes ?? null,
      })
      .returning();

    await logActivity({
      category: "bonus",
      action: "bonus.created",
      summary: `Bonus "${created.name}" created — ${created.percentage}% ${created.type}${created.period ? `, ${created.period}` : ""}`,
      actor: user,
      companyEntityId: created.company_entity_id,
      targetType: "bonus_plan",
      targetId: created.plan_id,
      targetLabel: created.name,
      context: {
        type: created.type,
        period: created.period,
        percentage: created.percentage,
        min_deposit: created.min_deposit,
        min_loss: created.min_loss,
      },
    });

    return Response.json({ plan: created }, { status: 201 });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return jsonError("A bonus with that name already exists", 409);
    }
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

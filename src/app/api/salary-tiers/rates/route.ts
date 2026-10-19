import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { salaryTiers, staffTierRates } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { csCasino, inCasinoScope } from "@/lib/salary";

const bodySchema = z.object({
  user_id: z.number().int().positive(),
  tier_id: z.number().int().positive(),
  // Null clears it: the rung's default applies again.
  amount: z.number().min(0).nullable(),
});

/**
 * PUT /api/salary-tiers/rates — what one rung pays one CS.
 *
 * Anyone who keeps the ladder may set it, except for themselves: a CS can set a
 * colleague's figure, not their own pay.
 */
export async function PUT(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    const body = parsed.data;

    if (body.user_id === user.user_id) {
      throw new AuthError(403, "Your own rate is set by someone else");
    }
    const cs = await csCasino(db, body.user_id);
    if (!cs) return jsonError("That account isn't a CS agent with a desk");
    const [tier] = await db.select().from(salaryTiers).where(eq(salaryTiers.tier_id, body.tier_id));
    if (!tier) return jsonError("Tier not found", 404);
    if (tier.company_entity_id !== cs.casinoId) {
      return jsonError("That tier belongs to another casino's ladder");
    }
    if (!inCasinoScope(user, cs.casinoId)) {
      throw new AuthError(403, "That casino is outside your organisation");
    }

    const key = and(eq(staffTierRates.user_id, body.user_id), eq(staffTierRates.tier_id, body.tier_id));
    const [before] = await db.select().from(staffTierRates).where(key);
    if (body.amount === null) {
      await db.delete(staffTierRates).where(key);
    } else {
      await db
        .insert(staffTierRates)
        .values({ user_id: body.user_id, tier_id: body.tier_id, amount: body.amount, updated_by_user_id: user.user_id })
        .onConflictDoUpdate({
          target: [staffTierRates.user_id, staffTierRates.tier_id],
          set: { amount: body.amount, updated_by_user_id: user.user_id, updated_at: new Date().toISOString() },
        });
    }

    const from = before ? `RM ${before.amount.toFixed(2)}` : `default RM ${tier.default_amount.toFixed(2)}`;
    const to = body.amount === null ? `default RM ${tier.default_amount.toFixed(2)}` : `RM ${body.amount.toFixed(2)}`;
    await logActivity({
      category: "payroll",
      action: "salary_rate.updated",
      summary: `${cs.user.full_name}'s pay at tier "${tier.name}": ${from} → ${to}`,
      actor: user,
      companyEntityId: cs.casinoId,
      targetType: "user",
      targetId: cs.user.user_id,
      targetLabel: cs.user.username,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

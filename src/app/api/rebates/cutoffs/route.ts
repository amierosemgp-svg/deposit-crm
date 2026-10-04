import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, settings } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { diffFields, logActivity } from "@/lib/activity-log";
import { loadRebateCutoffs, rebateCutoffsKey } from "@/lib/rebates";

const TIME = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Times must be HH:MM");

const schema = z.object({
  /** The casino these cutoffs are for; null is the shared fallback. */
  company_entity_id: z.number().int().positive().nullable(),
  cutoffs: z.object({
    daily: z.object({ time: TIME }),
    weekly: z.object({ weekday: z.number().int().min(0).max(6), time: TIME }),
    monthly: z.object({ day: z.number().int().min(1).max(31), time: TIME }),
  }),
});

/**
 * PUT /api/rebates/cutoffs — when a casino's rebate day, week and month roll
 * over. Each casino has its own: the super admin of its organisation sets it,
 * and so does a leader of a company that runs it. The shared fallback, used by
 * a casino that has set none, stays the super admin's.
 */
export async function PUT(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid cutoffs");
    }
    const { company_entity_id: casinoId, cutoffs } = parsed.data;

    let casinoName = "all casinos";
    if (casinoId === null) {
      if (user.role !== "super_admin") {
        throw new AuthError(403, "Only the super admin changes the shared cutoffs");
      }
    } else {
      const [casino] = await db
        .select({ name: entities.name, type: entities.entity_type })
        .from(entities)
        .where(eq(entities.entity_id, casinoId));
      if (!casino || casino.type !== "company") throw new AuthError(404, "Casino not found");
      casinoName = casino.name;
      const mayEdit =
        (user.role === "super_admin" || user.role === "company_leader") &&
        (user.companyIds === null || user.companyIds.includes(casinoId));
      if (!mayEdit) throw new AuthError(403, "You can't change this casino's cutoffs");
    }

    const before = await loadRebateCutoffs(casinoId);
    const key = rebateCutoffsKey(casinoId);
    const now = new Date().toISOString();
    await db
      .insert(settings)
      .values({ key, value: cutoffs, updated_at: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: cutoffs, updated_at: now } });

    await logActivity({
      category: "settings",
      action: "rebate.cutoffs_changed",
      summary: `Rebate cutoffs changed for ${casinoName}`,
      actor: user,
      companyEntityId: casinoId,
      targetType: "setting",
      targetLabel: key,
      changes: diffFields({ cutoffs: before }, { cutoffs }),
    });

    return Response.json({ cutoffs });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

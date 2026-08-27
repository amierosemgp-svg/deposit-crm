import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { diffFields, logActivity } from "@/lib/activity-log";

const schema = z.object({
  transfer_auto_confirm_hours: z.number().int().min(1).max(168).optional(),
  // Smallest withdrawable balance, in RM. 0 disables the check, which is the
  // default so adding this setting changes nothing until someone sets it.
  min_withdrawal_amount: z.number().min(0).max(1_000_000).optional(),
  games: z.array(z.string().min(1)).optional(),
  banks: z.array(z.string().min(1)).optional(),
});

const KEYS = [
  "transfer_auto_confirm_hours",
  "min_withdrawal_amount",
  "games",
  "banks",
] as const;

/** PATCH /api/settings — super_admin edits system configuration. */
export async function PATCH(request: Request) {
  try {
    const user = await requireWriteUser();
    if (user.role !== "super_admin") {
      throw new AuthError(403, "Only the super admin edits system settings");
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const patch = parsed.data;
    const nowIso = new Date().toISOString();

    // Read the old values first — after the upsert there is nothing to diff
    // against, and "settings changed" without the numbers is not an audit.
    const before = Object.fromEntries(
      (await db.select().from(settings)).map((r) => [r.key, r.value]),
    );

    for (const key of KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      await db
        .insert(settings)
        .values({ key, value, updated_at: nowIso })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: sql`excluded.value`, updated_at: nowIso },
        });
    }

    const changes = diffFields(before, patch);
    if (changes.length) {
      await logActivity({
        category: "settings",
        action: "settings.updated",
        summary: `System settings changed: ${changes.map((c) => c.field).join(", ")}`,
        actor: user,
        targetType: "settings",
        targetLabel: changes.map((c) => c.field).join(", ").slice(0, 120),
        changes,
      });
    }

    const rows = await db.select().from(settings);
    return Response.json({
      settings: Object.fromEntries(rows.map((r) => [r.key, r.value])),
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const schema = z.object({
  transfer_auto_confirm_hours: z.number().int().min(1).max(168).optional(),
  games: z.array(z.string().min(1)).optional(),
  banks: z.array(z.string().min(1)).optional(),
});

const KEYS = ["transfer_auto_confirm_hours", "games", "banks"] as const;

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

    const rows = await db.select().from(settings);
    return Response.json({
      settings: Object.fromEntries(rows.map((r) => [r.key, r.value])),
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

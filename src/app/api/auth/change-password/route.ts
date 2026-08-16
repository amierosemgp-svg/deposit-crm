import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity, requestContext } from "@/lib/activity-log";

const schema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, "New password must be at least 8 characters"),
});

/** POST /api/auth/change-password — the logged-in user changes their own password. */
export async function POST(request: Request) {
  try {
    const me = await requireUser();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const { current_password, new_password } = parsed.data;

    const [row] = await db.select().from(users).where(eq(users.user_id, me.user_id));
    if (!row) return jsonError("Account not found", 404);
    const ok = await bcrypt.compare(current_password, row.password_hash);
    if (!ok) {
      await logActivity({
        category: "auth",
        action: "auth.password_change_failed",
        summary: `${row.full_name} tried to change their password with the wrong current password`,
        actor: me,
        targetType: "user",
        targetId: me.user_id,
        targetLabel: row.username,
        context: requestContext(request),
      });
      return jsonError("Current password is incorrect", 403);
    }

    await db
      .update(users)
      .set({
        password_hash: await bcrypt.hash(new_password, 10),
        updated_at: new Date().toISOString(),
      })
      .where(eq(users.user_id, me.user_id));

    // The passwords themselves never touch the log — only the fact of it.
    await logActivity({
      category: "auth",
      action: "auth.password_changed",
      summary: `${row.full_name} changed their own password`,
      actor: me,
      targetType: "user",
      targetId: me.user_id,
      targetLabel: row.username,
      context: requestContext(request),
    });

    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

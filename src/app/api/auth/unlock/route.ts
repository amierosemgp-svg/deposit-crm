import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity, requestContext } from "@/lib/activity-log";
import { isClocked, openWorkSession } from "@/lib/work-sessions";

const bodySchema = z.object({ password: z.string().min(1) });

/**
 * POST /api/auth/unlock — back from the idle lock screen.
 *
 * The password again, because the point of the lock is that whoever sits down
 * at an unattended desk can't carry on as the person who left it. A right
 * answer starts a fresh work session; the page signs out after five wrong ones.
 */
export async function POST(request: Request) {
  try {
    const session = await requireUser();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Password required");

    const [user] = await db.select().from(users).where(eq(users.user_id, session.user_id));
    if (!user || user.status !== "active") return jsonError("Account is not active", 401);

    if (!(await bcrypt.compare(parsed.data.password, user.password_hash))) {
      await logActivity({
        category: "auth",
        action: "auth.unlock_failed",
        summary: `Wrong password on ${user.full_name}'s lock screen`,
        actorUserId: user.user_id,
        actorLabel: user.username,
        targetType: "user",
        targetId: user.user_id,
        targetLabel: user.username,
        context: requestContext(request),
      });
      return jsonError("Wrong password", 401);
    }

    if (isClocked(user.role)) await openWorkSession(user.user_id);
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

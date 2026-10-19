import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { closeWorkSession, isClocked } from "@/lib/work-sessions";

/**
 * POST /api/work-sessions/lock — the page locked after five idle minutes.
 *
 * Stops the clock at the last thing they did. The session cookie stays: the
 * lock screen asks only for the password, not a full sign-in.
 */
export async function POST() {
  try {
    const user = await requireUser();
    if (isClocked(user.role)) await closeWorkSession(user.user_id, "idle");
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { closeWorkSession, isClocked } from "@/lib/work-sessions";

/**
 * POST /api/work-sessions/lock — the page went an hour without input.
 *
 * Stops the clock at the last thing they did; the page signs out right after.
 * Done first, because signing out on its own ends the session "now".
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

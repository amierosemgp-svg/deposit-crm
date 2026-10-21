import { z } from "zod";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { isClocked, touchWorkSession, workSessionLive } from "@/lib/work-sessions";

const bodySchema = z.object({
  // True when there was real input since the last beat; false is the page
  // asking where it stands (on load) without claiming any activity.
  active: z.boolean(),
});

/**
 * POST /api/work-sessions/heartbeat — the idle sign-out's line to the clock.
 *
 * `tracked: false` for anyone not on the clock: the page then never signs them out.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!isClocked(user.role)) return Response.json({ tracked: false, locked: false });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("active must be true or false");
    const locked = parsed.data.active
      ? (await touchWorkSession(user.user_id)).locked
      : !(await workSessionLive(user.user_id));
    return Response.json({ tracked: true, locked });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

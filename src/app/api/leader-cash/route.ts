import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { leaderCash } from "@/lib/leader-cash";

/**
 * GET /api/leader-cash — each visible leader's cash on hand: the opening amount,
 * the cash leader transfers since, and what that leaves them holding now.
 * An admin sees their organisation's leaders, a leader sees their own, a CS
 * desk sees none.
 */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ leader_cash: await leaderCash(user) });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

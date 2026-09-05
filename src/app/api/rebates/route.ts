import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { loadRebateCutoffs, loadRebatePlanForUser, rebatePlanData } from "@/lib/rebates";

/**
 * GET /api/rebates?plan_id=&window_start= — one rebate plan's tab: the window
 * that just closed (and whether it's been generated), the windows generated
 * so far, and the payouts of the selected window (the newest by default).
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const planId = Number(url.searchParams.get("plan_id"));
    if (!Number.isInteger(planId) || planId <= 0) return jsonError("Provide plan_id");
    const plan = await loadRebatePlanForUser(user, planId);
    const cutoffs = await loadRebateCutoffs();
    const data = await rebatePlanData(
      plan,
      cutoffs,
      user.companyIds,
      url.searchParams.get("window_start"),
    );
    return Response.json(data);
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

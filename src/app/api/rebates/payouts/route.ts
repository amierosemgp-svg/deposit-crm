import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { listAllRebatePayouts } from "@/lib/rebates";

/**
 * GET /api/rebates/payouts — every generated rebate payout in the caller's
 * scope, all plans together, newest window first. The Rebate sheet on the
 * Transactions workbook reads this; paying and skipping go through
 * /api/rebates/pay and /api/rebates/:id as on the Rebates page.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const payouts = await listAllRebatePayouts(user.companyIds);
    return Response.json({ payouts });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

import { db } from "@/db";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { computeSalary, inCasinoScope, isMonth } from "@/lib/salary";

/**
 * GET /api/salaries/preview?user_id=&month=YYYY-MM — what paying this salary
 * would do: hours, days, the rung, its pay, every pending adjustment, the net.
 * The pay route recomputes all of it; this is for the person deciding.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sp = new URL(request.url).searchParams;
    const userId = Number(sp.get("user_id"));
    const month = sp.get("month") ?? "";
    if (!userId || !isMonth(month)) return jsonError("user_id and month (YYYY-MM) required");

    const preview = await computeSalary(db, userId, month);
    if ("error" in preview) return jsonError(preview.error);
    if (!inCasinoScope(user, preview.company_entity_id)) {
      throw new AuthError(403, "That CS is outside your organisation");
    }
    return Response.json({ preview });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

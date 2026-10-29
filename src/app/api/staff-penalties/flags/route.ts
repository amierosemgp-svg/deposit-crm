import { and, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { staffPenalties } from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * GET /api/staff-penalties/flags — the deposits, withdrawals and free credits
 * a live (not voided) staff penalty names, so the sheets can mark those rows.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const flags = { deposit: [] as number[], withdrawal: [] as number[], free_credit: [] as number[] };
    if (user.companyIds !== null && user.companyIds.length === 0) return Response.json({ flags });
    const rows = await db
      .select({ type: staffPenalties.source_type, id: staffPenalties.source_id })
      .from(staffPenalties)
      .where(
        and(
          ne(staffPenalties.status, "void"),
          isNotNull(staffPenalties.source_id),
          inArray(staffPenalties.source_type, ["deposit", "withdrawal", "free_credit"]),
          ...(user.companyIds === null ? [] : [inArray(staffPenalties.company_entity_id, user.companyIds)]),
        ),
      );
    for (const r of rows) {
      if (r.id != null && r.type in flags) flags[r.type as keyof typeof flags].push(r.id);
    }
    return Response.json({ flags });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

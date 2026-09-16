import { eq } from "drizzle-orm";
import { db } from "@/db";
import { entities } from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { freeCreditAllowance, freeCreditCapPct } from "@/lib/free-credit";

/**
 * GET /api/free-credits/allowance — how much free credit each company in the
 * caller's scope has left this month.
 *
 * The cap has always been enforced at the point of saving, which meant CS met
 * it as a rejection after typing the row. This is the same number ahead of
 * time, computed by the same function, so the sheet cannot advertise headroom
 * the save would then refuse.
 *
 * Not part of /api/state: it changes with every deposit and every credit
 * issued, whereas that payload is cached against players.updated_at.
 */
export async function GET() {
  try {
    const user = await requireUser();

    const companyIds =
      user.companyIds ??
      (
        await db
          .select({ id: entities.entity_id })
          .from(entities)
          .where(eq(entities.entity_type, "company"))
      ).map((e) => e.id);

    const pct = await freeCreditCapPct(db);
    const rows = await freeCreditAllowance(db, companyIds, pct);

    return Response.json({
      pct,
      // Infinity has no JSON form; an uncapped company reports null instead.
      allowances: rows.map((r) => ({
        ...r,
        allowance: Number.isFinite(r.allowance) ? r.allowance : null,
        left: Number.isFinite(r.left) ? r.left : null,
      })),
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

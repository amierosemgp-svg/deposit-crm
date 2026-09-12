import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { leadLists, listDistributions, listLeads, people } from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { formatCode } from "@/lib/lead-lists";

/**
 * GET /api/leads/lookup?phone=&company_entity_id= — which lead lists this phone
 * belongs to, and (for the given company) whether the list already has a
 * distribution here. Drives the Players sheet: enter a phone, pick its list,
 * and the prefix either fills itself (distribution exists) or is asked for once.
 */
export async function GET(request: Request) {
  try {
    await requireUser();
    const url = new URL(request.url);
    const phone = url.searchParams.get("phone")?.trim();
    const companyId = Number(url.searchParams.get("company_entity_id"));
    if (!phone) return Response.json({ lists: [] });

    // Every list this phone is a lead in.
    const rows = await db
      .select({
        list_id: leadLists.list_id,
        name: leadLists.name,
        owner_leader_entity_id: leadLists.owner_leader_entity_id,
      })
      .from(listLeads)
      .innerJoin(people, eq(people.person_id, listLeads.person_id))
      .innerJoin(leadLists, eq(leadLists.list_id, listLeads.list_id))
      .where(sql`lower(${people.contact_number}) = lower(${phone})`);

    // The distributions of those lists to this company, if any.
    const dists = Number.isFinite(companyId)
      ? await db
          .select()
          .from(listDistributions)
          .where(eq(listDistributions.to_entity_id, companyId))
      : [];
    const distByList = new Map(dists.map((d) => [d.list_id, d]));

    return Response.json({
      lists: rows.map((l) => {
        const dist = distByList.get(l.list_id);
        return {
          list_id: l.list_id,
          name: l.name,
          // When a distribution already exists, its prefix is fixed — the sheet
          // locks the field. Otherwise the sheet asks for one (creating it).
          dist_id: dist?.dist_id ?? null,
          prefix: dist?.prefix ?? null,
          next_code: dist ? formatCode(dist.prefix, dist.next_seq) : null,
        };
      }),
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

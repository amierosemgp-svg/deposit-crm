import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  entities,
  leadLists,
  listDistributions,
  listLeads,
  people,
  players,
} from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * GET /api/lead-lists/:id — the list with its leads (each flagged converted or
 * not, per distribution) and its distributions with conversion counts.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    if (user.role !== "super_admin" && user.role !== "company_leader") {
      throw new AuthError(403, "Leaders and admins only");
    }
    const listId = Number((await params).id);

    const [list] = await db.select().from(leadLists).where(eq(leadLists.list_id, listId));
    if (!list) return jsonError("List not found", 404);
    if (user.role !== "super_admin" && !user.ownedEntityIds?.includes(list.owner_leader_entity_id)) {
      throw new AuthError(403, "That list is outside your scope");
    }

    const leads = await db
      .select({
        lead_id: listLeads.lead_id,
        person_id: listLeads.person_id,
        lead_code: listLeads.lead_code,
        seq: listLeads.seq,
        full_name: people.full_name,
        contact_number: people.contact_number,
      })
      .from(listLeads)
      .innerJoin(people, eq(people.person_id, listLeads.person_id))
      .where(eq(listLeads.list_id, listId))
      .orderBy(listLeads.seq);

    const dists = await db
      .select()
      .from(listDistributions)
      .where(eq(listDistributions.list_id, listId));

    // Members converted from this list, so a lead shows where it landed.
    const distIds = dists.map((d) => d.dist_id);
    const members = distIds.length
      ? await db
          .select({
            person_id: players.person_id,
            source_dist_id: players.source_dist_id,
            member_code: players.username,
            company_entity_id: players.company_entity_id,
          })
          .from(players)
          .where(inArray(players.source_dist_id, distIds))
      : [];

    const ents = await db.select({ id: entities.entity_id, name: entities.name }).from(entities);
    const nameById = new Map(ents.map((e) => [e.id, e.name]));
    const total = leads.length;

    return Response.json({
      lead_list: {
        ...list,
        owner_leader_name: nameById.get(list.owner_leader_entity_id) ?? "—",
      },
      leads: leads.map((l) => ({
        ...l,
        conversions: members
          .filter((m) => m.person_id === l.person_id)
          .map((m) => ({
            member_code: m.member_code,
            company: nameById.get(m.company_entity_id) ?? "—",
            dist_id: m.source_dist_id,
          })),
      })),
      distributions: dists.map((d) => {
        const conv = members.filter((m) => m.source_dist_id === d.dist_id).length;
        return {
          ...d,
          to_name: nameById.get(d.to_entity_id) ?? "—",
          converted: conv,
          conversion_rate: total > 0 ? conv / total : 0,
        };
      }),
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

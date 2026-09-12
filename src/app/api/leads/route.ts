import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { leadLists, listLeads, people, players } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * GET /api/leads — every lead under the lists the user may see, with whether
 * that person has already become a member. Powers the Players page's Leads tab.
 *
 * Super-admin sees all lists; a company leader sees the lists they own.
 */
export async function GET() {
  try {
    const user = await requireUser();
    if (user.role !== "super_admin" && user.role !== "company_leader") {
      throw new AuthError(403, "Leaders and admins only");
    }

    const lists = await db.select().from(leadLists).orderBy(desc(leadLists.created_at));
    const visible =
      user.role === "super_admin"
        ? lists
        : lists.filter((l) => user.ownedEntityIds?.includes(l.owner_leader_entity_id));
    const listIds = visible.map((l) => l.list_id);
    const listById = new Map(visible.map((l) => [l.list_id, l]));

    const rows = listIds.length
      ? await db
          .select({
            lead_id: listLeads.lead_id,
            list_id: listLeads.list_id,
            seq: listLeads.seq,
            lead_code: listLeads.lead_code,
            person_id: listLeads.person_id,
            phone: people.contact_number,
            name: people.full_name,
            telegram: people.telegram_username,
          })
          .from(listLeads)
          .innerJoin(people, eq(people.person_id, listLeads.person_id))
          .where(inArray(listLeads.list_id, listIds))
      : [];

    // is_member: this person holds a membership somewhere.
    const personIds = [...new Set(rows.map((r) => r.person_id))];
    const members = personIds.length
      ? await db
          .select({ person_id: players.person_id })
          .from(players)
          .where(inArray(players.person_id, personIds))
      : [];
    const memberSet = new Set(members.map((m) => m.person_id));

    return Response.json({
      leads: rows
        .sort((a, b) => a.list_id - b.list_id || a.seq - b.seq)
        .map((r) => ({
          lead_id: r.lead_id,
          list_id: r.list_id,
          list_name: listById.get(r.list_id)?.name ?? "—",
          lead_code: r.lead_code,
          phone: r.phone,
          name: r.name,
          telegram: r.telegram,
          is_member: memberSet.has(r.person_id),
        })),
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

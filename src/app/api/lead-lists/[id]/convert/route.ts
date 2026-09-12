import { and, eq } from "drizzle-orm";
import { z } from "zod";
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
import { formatCode } from "@/lib/lead-lists";

const schema = z.object({
  dist_id: z.number().int().positive(),
  person_id: z.number().int().positive(),
});

/**
 * POST /api/lead-lists/:id/convert — turn a lead into a member under the
 * company a distribution points at. The member code auto-populates: prefix +
 * the distribution's next sequence, taken and bumped under a row lock so codes
 * never collide or skip. This is the "company_A creates list_B from list_A" step.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    if (user.role !== "super_admin" && user.role !== "company_leader") {
      throw new AuthError(403, "Leaders and admins only");
    }
    const listId = Number((await params).id);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Provide dist_id and person_id");
    const body = parsed.data;

    const result = await db.transaction(async (txn) => {
      const [dist] = await txn
        .select()
        .from(listDistributions)
        .where(eq(listDistributions.dist_id, body.dist_id))
        .for("update");
      if (!dist || dist.list_id !== listId) throw new AuthError(404, "Distribution not found");

      const [company] = await txn
        .select()
        .from(entities)
        .where(eq(entities.entity_id, dist.to_entity_id));
      if (!company || company.entity_type !== "company") {
        throw new AuthError(422, "This list was distributed to a leader, not a company — convert under one of their companies.");
      }
      if (user.role !== "super_admin" && !user.companyIds?.includes(company.entity_id)) {
        throw new AuthError(403, "That company is outside your scope");
      }

      // The lead must belong to this list.
      const [lead] = await txn
        .select()
        .from(listLeads)
        .where(and(eq(listLeads.list_id, listId), eq(listLeads.person_id, body.person_id)));
      if (!lead) throw new AuthError(404, "That person is not a lead in this list");

      const [person] = await txn.select().from(people).where(eq(people.person_id, body.person_id));
      if (!person) throw new AuthError(404, "Person not found");

      // Already converted at this company? Return the existing member.
      const [existing] = await txn
        .select()
        .from(players)
        .where(
          and(
            eq(players.company_entity_id, company.entity_id),
            eq(players.person_id, body.person_id),
          ),
        );
      if (existing) return { member: existing, already: true };

      const seq = dist.next_seq;
      const code = formatCode(dist.prefix, seq);
      const nowIso = new Date().toISOString();
      const [member] = await txn
        .insert(players)
        .values({
          username: code,
          full_name: person.full_name,
          contact_number: person.contact_number,
          telegram_username: person.telegram_username,
          wechat_id: person.wechat_id,
          company_entity_id: company.entity_id,
          person_id: person.person_id,
          source_dist_id: dist.dist_id,
          registration_date: nowIso,
        })
        .returning();
      await txn
        .update(listDistributions)
        .set({ next_seq: seq + 1 })
        .where(eq(listDistributions.dist_id, dist.dist_id));

      return { member, already: false };
    });

    return Response.json(result, { status: result.already ? 200 : 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

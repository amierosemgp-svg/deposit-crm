import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  entities,
  leadLists,
  listDistributions,
  listLeads,
  players,
} from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { findOrCreatePerson } from "@/lib/people";
import { formatCode } from "@/lib/lead-lists";

const schema = z.object({
  company_entity_id: z.number().int().positive(),
  contact_number: z.string().min(3).max(40),
  full_name: z.string().min(1).max(120),
  // List-linked path: the member code auto-numbers from the distribution.
  lead_list_id: z.number().int().positive().optional(),
  prefix: z.string().min(1).max(16).optional(),
  // Direct path (no list): the code is supplied.
  member_code: z.string().min(2).max(60).optional(),
});

/**
 * POST /api/players/from-lead — the Players-sheet create.
 *
 * With a lead list: resolve the person by phone, ensure they're a lead in the
 * list, find-or-create the list→company distribution (setting its prefix the
 * first time, reusing it after), and convert to a member with the
 * auto-numbered code. Without a list: a plain member with the given code.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    if (
      user.companyIds !== null &&
      !user.companyIds.includes(body.company_entity_id)
    ) {
      throw new AuthError(403, "Company is outside your scope");
    }

    const result = await db.transaction(async (txn) => {
      const [company] = await txn
        .select()
        .from(entities)
        .where(eq(entities.entity_id, body.company_entity_id));
      if (!company || company.entity_type !== "company") {
        throw new AuthError(422, "Not a company");
      }

      const { person } = await findOrCreatePerson(txn, {
        contact_number: body.contact_number,
        full_name: body.full_name,
      });

      // Already a member at this company? Return it (idempotent per phone).
      const [dupe] = await txn
        .select()
        .from(players)
        .where(
          and(
            eq(players.company_entity_id, body.company_entity_id),
            eq(players.person_id, person.person_id),
          ),
        );
      if (dupe) return { member: dupe, already: true };

      const nowIso = new Date().toISOString();

      // ---- direct (no list) ----
      if (!body.lead_list_id) {
        if (!body.member_code) throw new AuthError(422, "Provide a member code");
        const [member] = await txn
          .insert(players)
          .values({
            username: body.member_code.trim(),
            full_name: body.full_name,
            contact_number: body.contact_number,
            company_entity_id: body.company_entity_id,
            person_id: person.person_id,
            registration_date: nowIso,
          })
          .returning();
        return { member, already: false };
      }

      // ---- list-linked ----
      const [list] = await txn
        .select()
        .from(leadLists)
        .where(eq(leadLists.list_id, body.lead_list_id))
        .for("update");
      if (!list) throw new AuthError(404, "Lead list not found");

      // Ensure the person is a lead in the list (add if the sheet lets a new
      // phone through — keeps the list complete and conversion traceable).
      const [lead] = await txn
        .select()
        .from(listLeads)
        .where(
          and(eq(listLeads.list_id, list.list_id), eq(listLeads.person_id, person.person_id)),
        );
      if (!lead) {
        await txn.insert(listLeads).values({
          list_id: list.list_id,
          person_id: person.person_id,
          lead_code: formatCode(list.prefix, list.next_seq),
          seq: list.next_seq,
        });
        await txn
          .update(leadLists)
          .set({ next_seq: list.next_seq + 1 })
          .where(eq(leadLists.list_id, list.list_id));
      }

      // Find-or-create the distribution to this company; set its prefix the
      // first time only (it's fixed after — the sheet locks the field).
      let [dist] = await txn
        .select()
        .from(listDistributions)
        .where(
          and(
            eq(listDistributions.list_id, list.list_id),
            eq(listDistributions.to_entity_id, body.company_entity_id),
          ),
        )
        .for("update");
      if (!dist) {
        if (!body.prefix) throw new AuthError(422, "This company's prefix for the list is required");
        [dist] = await txn
          .insert(listDistributions)
          .values({
            list_id: list.list_id,
            to_entity_id: body.company_entity_id,
            prefix: body.prefix.trim(),
          })
          .returning();
      }

      const seq = dist.next_seq;
      const [member] = await txn
        .insert(players)
        .values({
          username: formatCode(dist.prefix, seq),
          full_name: body.full_name,
          contact_number: body.contact_number,
          company_entity_id: body.company_entity_id,
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

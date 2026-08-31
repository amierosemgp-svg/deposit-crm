import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leadLists, listLeads } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { findOrCreatePerson } from "@/lib/people";
import { formatCode } from "@/lib/lead-lists";

const schema = z.object({
  contact_number: z.string().min(3).max(40),
  full_name: z.string().min(1).max(120),
  telegram_username: z.string().max(80).optional(),
});

/**
 * POST /api/lead-lists/:id/leads — add a lead to the list.
 * Resolves the person by phone (one phone = one person) and stamps the list's
 * next lead code (prefix + sequence), auto-incremented under a row lock.
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
    if (!parsed.success) return jsonError("Provide contact_number and full_name");
    const body = parsed.data;

    const result = await db.transaction(async (txn) => {
      const [list] = await txn
        .select()
        .from(leadLists)
        .where(eq(leadLists.list_id, listId))
        .for("update");
      if (!list) throw new AuthError(404, "List not found");
      if (user.role !== "super_admin" && !user.ownedEntityIds?.includes(list.owner_leader_entity_id)) {
        throw new AuthError(403, "That list is outside your scope");
      }

      const { person } = await findOrCreatePerson(txn, {
        contact_number: body.contact_number,
        full_name: body.full_name,
        telegram_username: body.telegram_username,
      });

      // Already a lead in this list? Idempotent — return the existing row.
      const [dupe] = await txn
        .select()
        .from(listLeads)
        .where(and(eq(listLeads.list_id, listId), eq(listLeads.person_id, person.person_id)));
      if (dupe) return { lead: dupe, duplicate: true };

      const seq = list.next_seq;
      const [lead] = await txn
        .insert(listLeads)
        .values({
          list_id: listId,
          person_id: person.person_id,
          lead_code: formatCode(list.prefix, seq),
          seq,
        })
        .returning();
      await txn
        .update(leadLists)
        .set({ next_seq: seq + 1 })
        .where(eq(leadLists.list_id, listId));

      return { lead, duplicate: false };
    });

    return Response.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

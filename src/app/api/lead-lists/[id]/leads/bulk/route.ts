import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leadLists, listLeads } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { findOrCreatePerson } from "@/lib/people";
import { formatCode } from "@/lib/lead-lists";

const schema = z.object({
  rows: z
    .array(
      z.object({
        contact_number: z.string().min(3).max(40),
        full_name: z.string().min(1).max(120),
        telegram_username: z.string().max(80).optional(),
      }),
    )
    .min(1)
    .max(5000),
});

/**
 * POST /api/lead-lists/:id/leads/bulk — import many leads at once.
 * One transaction: each row resolves its person (one phone = one person) and,
 * unless already a lead in the list, takes the next sequential lead code. Rows
 * that are already leads (or repeat a phone within the batch) are skipped.
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
    if (!parsed.success) return jsonError("Provide rows: [{ contact_number, full_name }]");
    const { rows } = parsed.data;

    const result = await db.transaction(async (txn) => {
      const [list] = await txn
        .select()
        .from(leadLists)
        .where(eq(leadLists.list_id, listId))
        .for("update");
      if (!list) throw new AuthError(404, "List not found");
      if (
        user.role !== "super_admin" &&
        !user.ownedEntityIds?.includes(list.owner_leader_entity_id)
      ) {
        throw new AuthError(403, "That list is outside your scope");
      }

      // Start past both the list's counter and the highest seq actually in the
      // list — so a drifted next_seq can never collide with an existing lead.
      const [{ maxSeq }] = await txn
        .select({ maxSeq: sql<number | null>`max(${listLeads.seq})` })
        .from(listLeads)
        .where(eq(listLeads.list_id, listId));
      let seq = Math.max(list.next_seq, (maxSeq ?? 0) + 1);
      let added = 0;
      let skipped = 0;
      const seen = new Set<number>();

      for (const row of rows) {
        const { person } = await findOrCreatePerson(txn, {
          contact_number: row.contact_number,
          full_name: row.full_name,
          telegram_username: row.telegram_username,
        });
        // Duplicate within the batch, or already a lead in this list — skip.
        if (seen.has(person.person_id)) {
          skipped++;
          continue;
        }
        seen.add(person.person_id);
        const [dupe] = await txn
          .select({ lead_id: listLeads.lead_id })
          .from(listLeads)
          .where(and(eq(listLeads.list_id, listId), eq(listLeads.person_id, person.person_id)));
        if (dupe) {
          skipped++;
          continue;
        }
        await txn.insert(listLeads).values({
          list_id: listId,
          person_id: person.person_id,
          lead_code: formatCode(list.prefix, seq),
          seq,
        });
        seq++;
        added++;
      }

      if (added > 0) {
        await txn
          .update(leadLists)
          .set({ next_seq: seq })
          .where(eq(leadLists.list_id, listId));
      }
      return { added, skipped };
    });

    return Response.json(result, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

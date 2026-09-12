import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, leadLists, listDistributions } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const schema = z.object({
  to_entity_id: z.number().int().positive(),
  prefix: z.string().min(1).max(16),
});

/**
 * POST /api/lead-lists/:id/distribute — hand the list to a company (or another
 * leader). The company's prefix + auto-increment counter live on this row; a
 * conversion from the list uses them. Idempotent per (list, target).
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
    if (!parsed.success) return jsonError("Provide to_entity_id and prefix");
    const body = parsed.data;

    const [list] = await db.select().from(leadLists).where(eq(leadLists.list_id, listId));
    if (!list) return jsonError("List not found", 404);
    if (user.role !== "super_admin" && !user.ownedEntityIds?.includes(list.owner_leader_entity_id)) {
      throw new AuthError(403, "That list is outside your scope");
    }

    const [target] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, body.to_entity_id));
    if (!target || (target.entity_type !== "company" && target.entity_type !== "leader")) {
      return jsonError("Target must be a company or a leader");
    }

    const [row] = await db
      .insert(listDistributions)
      .values({ list_id: listId, to_entity_id: body.to_entity_id, prefix: body.prefix.trim() })
      // Re-distributing to the same target updates its prefix, keeps the counter.
      .onConflictDoUpdate({
        target: [listDistributions.list_id, listDistributions.to_entity_id],
        set: { prefix: body.prefix.trim() },
      })
      .returning();

    return Response.json({ distribution: row }, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

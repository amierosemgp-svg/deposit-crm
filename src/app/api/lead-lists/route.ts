import { desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  entities,
  leadLists,
  listDistributions,
  listLeads,
  players,
} from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * GET /api/lead-lists — every lead list the user may see, with its lead count
 * and, per company it's been distributed to, the conversion so far.
 *
 * Super-admin sees all; a company leader sees the lists they own.
 */
export async function GET() {
  try {
    const user = await requireUser();
    if (user.role !== "super_admin" && user.role !== "company_leader") {
      throw new AuthError(403, "Leaders and admins only");
    }

    const lists = await db.select().from(leadLists).orderBy(desc(leadLists.created_at));
    // A leader only owns lists under their own leader entity.
    const visible =
      user.role === "super_admin"
        ? lists
        : lists.filter((l) => user.ownedEntityIds?.includes(l.owner_leader_entity_id));

    const listIds = visible.map((l) => l.list_id);
    const [leadCounts, dists, converted, ents] = await Promise.all([
      listIds.length
        ? db
            .select({ list_id: listLeads.list_id, n: sql<number>`count(*)::int` })
            .from(listLeads)
            .where(inArray(listLeads.list_id, listIds))
            .groupBy(listLeads.list_id)
        : Promise.resolve([]),
      listIds.length
        ? db.select().from(listDistributions).where(inArray(listDistributions.list_id, listIds))
        : Promise.resolve([]),
      // Members converted per distribution.
      db
        .select({ dist: players.source_dist_id, n: sql<number>`count(*)::int` })
        .from(players)
        .where(sql`${players.source_dist_id} is not null`)
        .groupBy(players.source_dist_id),
      db.select({ id: entities.entity_id, name: entities.name }).from(entities),
    ]);

    const nameById = new Map(ents.map((e) => [e.id, e.name]));
    const leadN = new Map(leadCounts.map((r) => [r.list_id, r.n]));
    const convByDist = new Map(converted.map((r) => [r.dist, r.n]));

    return Response.json({
      lead_lists: visible.map((l) => {
        const total = leadN.get(l.list_id) ?? 0;
        return {
          ...l,
          owner_leader_name: nameById.get(l.owner_leader_entity_id) ?? "—",
          lead_count: total,
          distributions: dists
            .filter((d) => d.list_id === l.list_id)
            .map((d) => {
              const conv = convByDist.get(d.dist_id) ?? 0;
              return {
                ...d,
                to_name: nameById.get(d.to_entity_id) ?? "—",
                converted: conv,
                conversion_rate: total > 0 ? conv / total : 0,
              };
            }),
        };
      }),
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

const createSchema = z.object({
  owner_leader_entity_id: z.number().int().positive(),
  name: z.string().min(1).max(120),
  prefix: z.string().min(1).max(16),
  notes: z.string().max(500).optional(),
});

/** POST /api/lead-lists — create a list a leader has bought. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (user.role !== "super_admin" && user.role !== "company_leader") {
      throw new AuthError(403, "Leaders and admins only");
    }
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    const [leader] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, body.owner_leader_entity_id));
    if (!leader || leader.entity_type !== "leader") {
      return jsonError("Owner must be a leader");
    }
    if (user.role !== "super_admin" && !user.ownedEntityIds?.includes(leader.entity_id)) {
      throw new AuthError(403, "That leader is outside your scope");
    }

    const [row] = await db
      .insert(leadLists)
      .values({
        owner_leader_entity_id: body.owner_leader_entity_id,
        name: body.name.trim(),
        prefix: body.prefix.trim(),
        notes: body.notes ?? null,
      })
      .returning();

    return Response.json({ lead_list: row }, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

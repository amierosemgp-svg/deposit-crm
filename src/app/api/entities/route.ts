import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { assignCompanyToLeader } from "@/lib/company-leaders";
import { logActivity } from "@/lib/activity-log";

const createSchema = z.object({
  parent_entity_id: z.number().int().positive(),
  entity_type: z.enum(["leader", "company", "cs"]),
  name: z.string().min(1),
});

const VALID_PARENT: Record<string, string> = {
  leader: "main_company",
  company: "leader",
  cs: "company",
};

/**
 * POST /api/entities — grow the hierarchy.
 * super_admin: leaders/companies/cs anywhere in their own organisation;
 * company_leader: companies + cs under themselves.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (user.role === "cs_agent") {
      throw new AuthError(403, "CS agents cannot modify the hierarchy");
    }
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    const [parent] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, body.parent_entity_id));
    if (!parent) return jsonError("Parent entity not found", 404);
    if (parent.entity_type !== VALID_PARENT[body.entity_type]) {
      return jsonError(
        `A ${body.entity_type} must sit under a ${VALID_PARENT[body.entity_type]} (got ${parent.entity_type})`,
      );
    }

    if (user.role === "company_leader") {
      const allowedParents = [user.entity_id, ...(user.companyIds ?? [])];
      if (!allowedParents.includes(body.parent_entity_id)) {
        throw new AuthError(403, "Parent entity is outside your scope");
      }
    } else if (
      user.role === "super_admin" &&
      user.ownedEntityIds !== null &&
      !user.ownedEntityIds.includes(body.parent_entity_id)
    ) {
      // "Anywhere" is anywhere in their own organisation. Hanging a leader off
      // somebody else's main company was previously unchecked.
      throw new AuthError(403, "Parent entity belongs to another organisation");
    }

    /**
     * A casino needs an owner the moment it exists.
     *
     * The hierarchy draws casinos from company_leaders, not from
     * parent_entity_id — a casino can be run by more than one company, so
     * ownership is its own table. Creating one without that row left it real
     * but invisible: saved, reported as created, and shown under nobody.
     *
     * So the company it was created under becomes its primary owner, in the
     * same transaction. The parent is already checked above.
     */
    const created = await db.transaction(async (txn) => {
      const [row] = await txn.insert(entities).values(body).returning();
      if (row.entity_type === "company") {
        await assignCompanyToLeader(
          {
            companyEntityId: row.entity_id,
            leaderEntityId: body.parent_entity_id,
            primary: true,
            note: "Created under this company",
            byUserId: user.user_id,
          },
          txn,
        );
      }
      return row;
    });

    await logActivity({
      category: "entity",
      action: "entity.created",
      summary: `${created.entity_type.replace("_", " ")} "${created.name}" created under ${parent.name}`,
      actor: user,
      companyEntityId:
        created.entity_type === "company"
          ? created.entity_id
          : created.entity_type === "cs"
            ? created.parent_entity_id
            : null,
      targetType: "entity",
      targetId: created.entity_id,
      targetLabel: created.name,
      context: { entity_type: created.entity_type, parent: parent.name },
    });

    return Response.json({ entity: created }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

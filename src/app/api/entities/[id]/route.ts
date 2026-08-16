import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities } from "@/db/schema";
import {
  AuthError,
  authErrorResponse,
  requireWriteUser,
  type AuthedUser,
} from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { describeChanges, diffFields, logActivity } from "@/lib/activity-log";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    status: z.enum(["active", "inactive"]).optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: "Nothing to update",
  });

type EntityRow = typeof entities.$inferSelect;

/**
 * Who may edit a node — the mirror of the POST rules in ../route.ts:
 * super_admin anywhere; a company_leader only within their own subtree
 * (their leader entity, its companies, and those companies' CS desks).
 */
function assertCanEdit(user: AuthedUser, entity: EntityRow) {
  if (user.role === "cs_agent") {
    throw new AuthError(403, "CS agents cannot modify the hierarchy");
  }
  if (user.role === "super_admin") return;
  if (entity.entity_id === user.entity_id) return;
  if (
    entity.entity_type === "company" &&
    entity.parent_entity_id === user.entity_id
  ) {
    return;
  }
  if (
    entity.entity_type === "cs" &&
    entity.parent_entity_id !== null &&
    (user.companyIds ?? []).includes(entity.parent_entity_id)
  ) {
    return;
  }
  throw new AuthError(403, "Entity is outside your scope");
}

/**
 * PATCH /api/entities/:id — rename, or flip active/inactive.
 * Entities are never deleted: they anchor players, bank accounts and history,
 * so retiring one means setting status = "inactive".
 * entity_type and parent_entity_id are immutable — moving a node would
 * re-scope every record hanging off it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const entityId = Number(id);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      return jsonError("Invalid entity id");
    }

    const [row] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, entityId));
    if (!row) return jsonError("Entity not found", 404);
    assertCanEdit(user, row);

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const patch = parsed.data;

    if (patch.status && row.entity_type === "main_company") {
      return jsonError("The main company cannot be deactivated", 422);
    }

    const [updated] = await db
      .update(entities)
      .set(patch)
      .where(eq(entities.entity_id, entityId))
      .returning();

    const changes = diffFields(row, patch);
    if (changes.length) {
      await logActivity({
        category: "entity",
        action:
          patch.status && patch.status !== row.status
            ? `entity.${patch.status === "active" ? "reactivated" : "deactivated"}`
            : "entity.updated",
        summary: `${row.entity_type.replace("_", " ")} "${row.name}" — ${describeChanges(changes)}`,
        actor: user,
        companyEntityId:
          row.entity_type === "company"
            ? row.entity_id
            : row.entity_type === "cs"
              ? row.parent_entity_id
              : null,
        targetType: "entity",
        targetId: row.entity_id,
        targetLabel: row.name,
        changes,
      });
    }

    return Response.json({ entity: updated });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

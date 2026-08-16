import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { companyOfEntity, diffFields, logActivity } from "@/lib/activity-log";

/** Load the target user and confirm the requester may manage them. */
async function loadManageable(
  requester: Awaited<ReturnType<typeof requireWriteUser>>,
  targetId: number,
) {
  if (requester.role === "cs_agent" || requester.role === "viewer") {
    throw new AuthError(403, "You cannot manage users");
  }
  const [target] = await db.select().from(users).where(eq(users.user_id, targetId));
  if (!target) throw new AuthError(404, "User not found");
  if (target.user_id === requester.user_id) {
    throw new AuthError(422, "You cannot change your own account here");
  }

  if (requester.role === "company_leader") {
    // Leaders may only manage CS agents whose company is one of theirs.
    if (target.role !== "cs_agent") {
      throw new AuthError(403, "Leaders can only manage CS agents");
    }
    const [csEntity] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, target.entity_id));
    if (
      !csEntity ||
      csEntity.parent_entity_id === null ||
      !(requester.companyIds ?? []).includes(csEntity.parent_entity_id)
    ) {
      throw new AuthError(403, "That CS agent is outside your companies");
    }
  }
  return target;
}

const patchSchema = z.object({
  full_name: z.string().min(1).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

/** PATCH /api/users/:id — rename or deactivate/reactivate a user. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const requester = await requireWriteUser();
    const { id } = await params;
    const target = await loadManageable(requester, Number(id));
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");

    const [updated] = await db
      .update(users)
      .set({ ...parsed.data, updated_at: new Date().toISOString() })
      .where(eq(users.user_id, Number(id)))
      .returning({
        user_id: users.user_id,
        username: users.username,
        full_name: users.full_name,
        role: users.role,
        entity_id: users.entity_id,
        status: users.status,
      });

    const changes = diffFields(target, parsed.data);
    if (changes.length) {
      await logActivity({
        category: "user",
        action:
          parsed.data.status && parsed.data.status !== target.status
            ? `user.${parsed.data.status === "active" ? "reactivated" : "deactivated"}`
            : "user.updated",
        summary: `${target.role.replace("_", " ")} "${target.username}" updated`,
        actor: requester,
        companyEntityId: await companyOfEntity(target.entity_id),
        targetType: "user",
        targetId: target.user_id,
        targetLabel: target.username,
        changes,
      });
    }

    return Response.json({ user: updated });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/**
 * DELETE /api/users/:id — remove a user. If they were the only member of a CS
 * desk, the empty desk entity is removed too. Never removes the last super_admin.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const requester = await requireWriteUser();
    const { id } = await params;
    const target = await loadManageable(requester, Number(id));
    // Resolved before the delete: an emptied CS desk is removed with the user,
    // and the company would be unresolvable afterwards.
    const companyEntityId = await companyOfEntity(target.entity_id);

    if (target.role === "super_admin") {
      const admins = await db
        .select({ id: users.user_id })
        .from(users)
        .where(eq(users.role, "super_admin"));
      if (admins.length <= 1) {
        return jsonError("Cannot remove the last super admin", 422);
      }
    }

    await db.transaction(async (txn) => {
      await txn.delete(users).where(eq(users.user_id, target.user_id));
      // Clean up an orphaned CS desk entity
      const [entity] = await txn
        .select()
        .from(entities)
        .where(eq(entities.entity_id, target.entity_id));
      if (entity?.entity_type === "cs") {
        const [stillUsed] = await txn
          .select({ id: users.user_id })
          .from(users)
          .where(
            and(eq(users.entity_id, entity.entity_id), ne(users.user_id, target.user_id)),
          );
        if (!stillUsed) {
          await txn.delete(entities).where(eq(entities.entity_id, entity.entity_id));
        }
      }
    });

    await logActivity({
      category: "user",
      action: "user.deleted",
      summary: `${target.role.replace("_", " ")} "${target.username}" (${target.full_name}) deleted`,
      actor: requester,
      companyEntityId,
      targetType: "user",
      targetId: target.user_id,
      targetLabel: target.username,
      context: { role: target.role, email: target.email },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

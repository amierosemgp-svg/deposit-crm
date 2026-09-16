import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { companyOfEntity, logActivity } from "@/lib/activity-log";

const createSchema = z.object({
  username: z.string().min(2).regex(/^[a-z0-9_]+$/i, "Letters, numbers, underscores only"),
  /**
   * Both optional for an account on the main company.
   *
   * Those are the operator's own logins — they sign in with a username and
   * nobody emails them. Insisting on an address produced made-up ones, which
   * is worse than not asking: a fake address in a unique column is a real
   * collision waiting to happen. Defaults below are derived and never shown as
   * something to contact.
   */
  email: z.string().email().optional(),
  full_name: z.string().min(1).optional(),
  password: z.string().min(8),
  role: z.enum(["company_leader", "cs_agent", "viewer"]),
  entity_id: z.number().int().positive(),
});

const ROLE_ENTITY: Record<string, string[]> = {
  company_leader: ["leader"],
  cs_agent: ["cs"],
  viewer: ["main_company", "leader", "company"],
};

/** POST /api/users — onboard team members (admin: any; leader: cs under own companies). */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (user.role === "cs_agent") {
      throw new AuthError(403, "CS agents cannot create users");
    }
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const body = parsed.data;

    const [entity] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, body.entity_id));
    if (!entity) return jsonError("Entity not found", 404);
    // Everyone else still has to give both: a leader or CS agent is a person
    // somebody needs to be able to name and reach.
    if (entity.entity_type !== "main_company" && (!body.email || !body.full_name)) {
      return jsonError("Email and full name are required outside the main company");
    }
    if (!ROLE_ENTITY[body.role].includes(entity.entity_type)) {
      return jsonError(
        `A ${body.role} must be attached to a ${ROLE_ENTITY[body.role].join("/")} entity`,
      );
    }

    if (user.role === "company_leader") {
      if (body.role !== "cs_agent") {
        throw new AuthError(403, "Leaders can only create CS agents");
      }
      // cs entity's parent company must be one of the leader's companies
      if (
        entity.parent_entity_id === null ||
        !(user.companyIds ?? []).includes(entity.parent_entity_id)
      ) {
        throw new AuthError(403, "CS desk is outside your companies");
      }
    } else if (
      user.role === "super_admin" &&
      user.ownedEntityIds !== null &&
      !user.ownedEntityIds.includes(entity.entity_id)
    ) {
      // A super admin creating logins inside another organisation's tree is
      // the same breach as editing it — one main company, one super admin.
      throw new AuthError(403, "Entity belongs to another organisation");
    }

    const [created] = await db
      .insert(users)
      .values({
        username: body.username.toLowerCase(),
        // Derived, not invented, when the main company left them out: scoped by
        // entity so two organisations can each have an "admin" without
        // colliding on the unique email column.
        email:
          body.email?.toLowerCase() ??
          `${body.username.toLowerCase()}@e${entity.entity_id}.local`,
        full_name: body.full_name ?? body.username,
        password_hash: await bcrypt.hash(body.password, 10),
        role: body.role,
        entity_id: body.entity_id,
      })
      .returning();

    await logActivity({
      category: "user",
      action: "user.created",
      summary: `${body.role.replace("_", " ")} "${created.username}" (${created.full_name}) created under ${entity.name}`,
      actor: user,
      companyEntityId: await companyOfEntity(entity.entity_id),
      targetType: "user",
      targetId: created.user_id,
      targetLabel: created.username,
      context: { role: created.role, entity: entity.name, email: created.email },
    });

    const { password_hash: _hash, ...safe } = created;
    return Response.json({ user: safe }, { status: 201 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    if (e instanceof Error && e.message.includes("duplicate")) {
      return jsonError("Username or email already exists", 409);
    }
    console.error(e);
    return jsonError("Server error", 500);
  }
}

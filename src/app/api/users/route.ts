import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const createSchema = z.object({
  username: z.string().min(2).regex(/^[a-z0-9_]+$/i, "Letters, numbers, underscores only"),
  email: z.string().email(),
  full_name: z.string().min(1),
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
    }

    const [created] = await db
      .insert(users)
      .values({
        username: body.username.toLowerCase(),
        email: body.email.toLowerCase(),
        full_name: body.full_name,
        password_hash: await bcrypt.hash(body.password, 10),
        role: body.role,
        entity_id: body.entity_id,
      })
      .returning();

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

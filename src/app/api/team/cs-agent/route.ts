import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const schema = z.object({
  company_entity_id: z.number().int().positive(),
  full_name: z.string().min(1),
  username: z.string().min(2).regex(/^[a-z0-9_]+$/i, "Letters, numbers, underscores only"),
  email: z.string().email(),
  password: z.string().min(8),
});

/**
 * POST /api/team/cs-agent — add a CS agent to a company in one step.
 * Creates the CS desk entity + the cs_agent user atomically.
 * super_admin: any company. company_leader: only their own companies.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (user.role === "cs_agent" || user.role === "viewer") {
      throw new AuthError(403, "You cannot add team members");
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const body = parsed.data;

    const [company] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, body.company_entity_id));
    if (!company || company.entity_type !== "company") {
      return jsonError("Pick a valid company for the CS agent");
    }
    if (
      user.companyIds !== null &&
      !user.companyIds.includes(body.company_entity_id)
    ) {
      throw new AuthError(403, "That company is outside your scope");
    }

    const result = await db.transaction(async (txn) => {
      const [csEntity] = await txn
        .insert(entities)
        .values({
          parent_entity_id: body.company_entity_id,
          entity_type: "cs",
          name: body.full_name,
        })
        .returning();
      const [created] = await txn
        .insert(users)
        .values({
          username: body.username.toLowerCase(),
          email: body.email.toLowerCase(),
          full_name: body.full_name,
          password_hash: await bcrypt.hash(body.password, 10),
          role: "cs_agent",
          entity_id: csEntity.entity_id,
        })
        .returning();
      return created;
    });

    const { password_hash: _h, ...safe } = result;
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

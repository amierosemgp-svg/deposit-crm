import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const schema = z.object({
  full_name: z.string().min(1),
  company_name: z.string().min(1).optional(), // optionally spin up their first company
  username: z.string().min(2).regex(/^[a-z0-9_]+$/i, "Letters, numbers, underscores only"),
  email: z.string().email(),
  password: z.string().min(8),
});

/**
 * POST /api/team/leader — super_admin adds a leader (shareholder).
 * Creates the leader entity under the main company + the company_leader user,
 * and optionally their first company.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (user.role !== "super_admin") {
      throw new AuthError(403, "Only the super admin can add leaders");
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const body = parsed.data;

    const [main] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_type, "main_company"));
    if (!main) return jsonError("Main company entity missing", 500);

    const result = await db.transaction(async (txn) => {
      const [leaderEntity] = await txn
        .insert(entities)
        .values({
          parent_entity_id: main.entity_id,
          entity_type: "leader",
          name: body.full_name,
        })
        .returning();
      if (body.company_name) {
        await txn.insert(entities).values({
          parent_entity_id: leaderEntity.entity_id,
          entity_type: "company",
          name: body.company_name,
        });
      }
      const [created] = await txn
        .insert(users)
        .values({
          username: body.username.toLowerCase(),
          email: body.email.toLowerCase(),
          full_name: body.full_name,
          password_hash: await bcrypt.hash(body.password, 10),
          role: "company_leader",
          entity_id: leaderEntity.entity_id,
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

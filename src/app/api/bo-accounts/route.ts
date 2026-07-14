import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, providerBoAccounts } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const createSchema = z.object({
  company_entity_id: z.number().int().positive(),
  game_name: z.string().min(1),
  bo_username: z.string().min(1),
  bo_label: z.string().optional(),
  current_credit: z.number().min(0).default(0),
  status: z.enum(["active", "inactive"]).default("active"),
  notes: z.string().optional(),
});

/** POST /api/bo-accounts — register a game-provider back-office credit pool. */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (user.role === "cs_agent") {
      throw new AuthError(403, "Only leaders and admins manage BO accounts");
    }
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    if (
      user.companyIds !== null &&
      !user.companyIds.includes(body.company_entity_id)
    ) {
      throw new AuthError(403, "Company is outside your scope");
    }
    const [company] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, body.company_entity_id));
    if (!company || company.entity_type !== "company") {
      return jsonError("BO accounts belong to company entities");
    }

    const [created] = await db.insert(providerBoAccounts).values(body).returning();
    return Response.json({ boAccount: created }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

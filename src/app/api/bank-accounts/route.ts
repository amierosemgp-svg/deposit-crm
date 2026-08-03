import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, entities } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const createSchema = z.object({
  entity_id: z.number().int().positive(),
  role: z.enum(["deposit", "withdrawal"]),
  bank_name: z.string().min(1),
  account_number: z.string().min(4),
  account_holder: z.string().min(1),
  label: z.string().optional(),
  login_id: z.string().optional(),
  login_password: z.string().optional(),
  login_pin: z.string().optional(),
  device_id: z.string().max(120).optional(),
  current_balance: z.number().min(0).default(0),
  status: z.enum(["active", "inactive"]).default("active"),
});

/** POST /api/bank-accounts — leaders/admins add accounts for their entities. */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (user.role === "cs_agent") {
      throw new AuthError(403, "Only leaders and admins manage bank accounts");
    }
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    if (
      user.ownedEntityIds !== null &&
      !user.ownedEntityIds.includes(body.entity_id)
    ) {
      throw new AuthError(403, "Entity is outside your scope");
    }
    const [entity] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, body.entity_id));
    if (!entity) return jsonError("Entity not found", 404);
    if (!["leader", "company", "main_company"].includes(entity.entity_type)) {
      return jsonError("Bank accounts belong to companies, leaders, or the main company");
    }

    const [created] = await db.insert(bankAccounts).values(body).returning();
    return Response.json({ account: created }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

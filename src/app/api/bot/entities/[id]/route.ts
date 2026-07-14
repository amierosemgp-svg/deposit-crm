import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, entities, players, users } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { entityJson, isFkViolation, jsonError } from "@/lib/bot-crud";

/** GET /api/bot/entities/:id */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const [row] = await db
    .select()
    .from(entities)
    .where(eq(entities.entity_id, Number(id)));
  if (!row) return jsonError("Entity not found", 404);
  return Response.json({ entity: entityJson(row) });
}

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

/** PATCH /api/bot/entities/:id — rename or set status. Type/parent are immutable. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid payload");

  const [updated] = await db
    .update(entities)
    .set(parsed.data)
    .where(eq(entities.entity_id, Number(id)))
    .returning();
  if (!updated) return jsonError("Entity not found", 404);
  return Response.json({ entity: entityJson(updated) });
}

/**
 * DELETE /api/bot/entities/:id — removes an entity only when it has no child
 * entities, users, players, or bank accounts attached (409 otherwise).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const entityId = Number(id);

  const [row] = await db.select().from(entities).where(eq(entities.entity_id, entityId));
  if (!row) return jsonError("Entity not found", 404);
  if (row.entity_type === "main_company") {
    return jsonError("The main company entity cannot be deleted", 422);
  }

  const [childEntity] = await db
    .select({ id: entities.entity_id })
    .from(entities)
    .where(eq(entities.parent_entity_id, entityId));
  const [childUser] = await db
    .select({ id: users.user_id })
    .from(users)
    .where(eq(users.entity_id, entityId));
  const [childPlayer] = await db
    .select({ id: players.player_id })
    .from(players)
    .where(eq(players.company_entity_id, entityId));
  const [childAccount] = await db
    .select({ id: bankAccounts.account_id })
    .from(bankAccounts)
    .where(eq(bankAccounts.entity_id, entityId));

  if (childEntity || childUser || childPlayer || childAccount) {
    return jsonError(
      "Entity still has children (sub-entities, users, players, or bank accounts). Remove those first.",
      409,
    );
  }

  try {
    await db.delete(entities).where(eq(entities.entity_id, entityId));
    return Response.json({ ok: true, deleted: entityId });
  } catch (e) {
    if (isFkViolation(e)) return jsonError("Entity is still referenced elsewhere", 409);
    console.error(e);
    return jsonError("Server error", 500);
  }
}

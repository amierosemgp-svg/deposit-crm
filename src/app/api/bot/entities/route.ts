import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { entityJson, jsonError, VALID_PARENT } from "@/lib/bot-crud";

/** GET /api/bot/entities?type=&parent_entity_id= — full hierarchy list. */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const parent = url.searchParams.get("parent_entity_id");

  let rows = await db.select().from(entities);
  if (type) rows = rows.filter((e) => e.entity_type === type);
  if (parent) rows = rows.filter((e) => e.parent_entity_id === Number(parent));

  return Response.json({ count: rows.length, entities: rows.map(entityJson) });
}

const createSchema = z.object({
  entity_type: z.enum(["leader", "company", "cs"]),
  name: z.string().min(1),
  parent_entity_id: z.number().int().positive(),
});

/** POST /api/bot/entities — add a leader, company, or CS desk under a valid parent. */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
  }
  const body = parsed.data;

  const [parent] = await db
    .select()
    .from(entities)
    .where(eq(entities.entity_id, body.parent_entity_id));
  if (!parent) return jsonError("Parent entity not found", 404);
  if (parent.entity_type !== VALID_PARENT[body.entity_type]) {
    return jsonError(
      `A ${body.entity_type} must sit under a ${VALID_PARENT[body.entity_type]} (parent is ${parent.entity_type})`,
    );
  }

  const [created] = await db.insert(entities).values(body).returning();
  return Response.json({ entity: entityJson(created) }, { status: 201 });
}

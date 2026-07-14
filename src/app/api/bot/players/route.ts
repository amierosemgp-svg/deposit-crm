import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, players } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { isUniqueViolation, jsonError, playerJson } from "@/lib/bot-crud";

/** GET /api/bot/players?company_entity_id=&q=&status=&limit=&offset= */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const companyId = url.searchParams.get("company_entity_id");
  const q = url.searchParams.get("q");
  const status = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const filters: SQL[] = [];
  if (companyId) filters.push(eq(players.company_entity_id, Number(companyId)));
  if (status === "active" || status === "suspended") {
    filters.push(eq(players.status, status));
  }
  if (q) {
    filters.push(
      or(
        ilike(players.username, `%${q}%`),
        ilike(players.full_name, `%${q}%`),
        ilike(players.telegram_username, `%${q}%`),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(players)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(players.player_id))
    .limit(limit)
    .offset(offset);

  return Response.json({ count: rows.length, players: rows.map(playerJson) });
}

const createSchema = z.object({
  username: z.string().min(2).regex(/^[a-z0-9_.]+$/i, "Letters, numbers, dot, underscore only"),
  full_name: z.string().min(1),
  telegram_username: z.string().min(2),
  company_entity_id: z.number().int().positive(),
  contact_number: z.string().optional(),
  wechat_id: z.string().optional(),
  notes: z.string().optional(),
  bank_accounts: z
    .array(z.object({ bank_name: z.string(), account_number: z.string(), account_holder: z.string() }))
    .optional(),
  game_accounts: z
    .array(z.object({ game_name: z.string(), game_username: z.string() }))
    .optional(),
});

/**
 * POST /api/bot/players — create a player.
 * Idempotent on username: re-sending an existing username returns that player
 * with { "duplicate": true } and HTTP 200 rather than erroring.
 */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
  }
  const body = parsed.data;

  const [existing] = await db
    .select()
    .from(players)
    .where(eq(players.username, body.username.toLowerCase()));
  if (existing) {
    return Response.json({ duplicate: true, player: playerJson(existing) }, { status: 200 });
  }

  const [company] = await db
    .select()
    .from(entities)
    .where(eq(entities.entity_id, body.company_entity_id));
  if (!company || company.entity_type !== "company") {
    return jsonError(`Entity ${body.company_entity_id} is not a company`);
  }

  try {
    const [created] = await db
      .insert(players)
      .values({
        username: body.username.toLowerCase(),
        full_name: body.full_name,
        telegram_username: body.telegram_username.startsWith("@")
          ? body.telegram_username
          : `@${body.telegram_username}`,
        company_entity_id: body.company_entity_id,
        contact_number: body.contact_number,
        wechat_id: body.wechat_id,
        notes: body.notes,
        bank_accounts: body.bank_accounts,
        game_accounts: body.game_accounts,
      })
      .returning();
    return Response.json({ player: playerJson(created) }, { status: 201 });
  } catch (e) {
    if (isUniqueViolation(e)) return jsonError("Username already exists", 409);
    console.error(e);
    return jsonError("Server error", 500);
  }
}

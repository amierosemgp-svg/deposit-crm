import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameAccountPool } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { jsonError } from "@/lib/bot-crud";
import { poolStock } from "@/lib/game-account-pool";

const POOL_STATUSES = ["available", "assigned", "retired"] as const;

function poolJson(row: typeof gameAccountPool.$inferSelect) {
  return {
    pool_id: row.pool_id,
    game_name: row.game_name,
    game_username: row.game_username,
    company_entity_id: row.company_entity_id,
    status: row.status,
    assigned_player_id: row.assigned_player_id,
    assigned_at: row.assigned_at,
    note: row.note,
    created_at: row.created_at,
  };
}

/**
 * GET /api/bot/game-account-pool?game_name=&status=&limit=&offset=
 * With ?stock=1, returns just the per-game available counts — what you poll to
 * decide whether to go and register more accounts.
 */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  if (url.searchParams.get("stock")) {
    return Response.json({ stock: await poolStock() });
  }

  const gameName = url.searchParams.get("game_name");
  const statusParam = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const filters: SQL[] = [];
  if (gameName) filters.push(eq(gameAccountPool.game_name, gameName));
  if (statusParam) {
    const wanted = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is (typeof POOL_STATUSES)[number] =>
        (POOL_STATUSES as readonly string[]).includes(s),
      );
    if (!wanted.length) {
      return jsonError(`Invalid status. Use: ${POOL_STATUSES.join(", ")}`);
    }
    filters.push(inArray(gameAccountPool.status, wanted));
  }

  const rows = await db
    .select()
    .from(gameAccountPool)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(gameAccountPool.game_name), desc(gameAccountPool.pool_id))
    .limit(limit)
    .offset(offset);

  return Response.json({ count: rows.length, accounts: rows.map(poolJson) });
}

const accountSchema = z.object({
  game_name: z.string().min(1),
  game_username: z.string().min(1),
  game_password: z.string().optional(),
  company_entity_id: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
});

// Accepts one account or a batch — registering accounts is a batch job.
const createSchema = z.union([
  accountSchema,
  z.object({ accounts: z.array(accountSchema).min(1).max(500) }),
]);

/**
 * POST /api/bot/game-account-pool — add accounts you've registered at the
 * provider to the pool, ready to hand to players.
 *
 * Idempotent on (game_name, game_username): re-sending an account already in
 * the pool leaves it exactly as it is and reports it as a duplicate. Re-running
 * a batch after a timeout is therefore safe and will not resurrect an account
 * that has since been assigned or retired.
 */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      parsed.error.issues[0]?.message ??
        "Send {game_name, game_username} or {accounts: [...]}",
    );
  }
  const incoming =
    "accounts" in parsed.data ? parsed.data.accounts : [parsed.data];

  // A key scoped to one company may only stock that company's shelf.
  if (auth.companyId !== null) {
    const bad = incoming.find(
      (a) =>
        a.company_entity_id !== undefined &&
        a.company_entity_id !== auth.companyId,
    );
    if (bad) {
      return jsonError(
        `Entity ${bad.company_entity_id} is outside this key's company scope`,
        403,
      );
    }
  }

  const inserted = await db
    .insert(gameAccountPool)
    .values(
      incoming.map((a) => ({
        game_name: a.game_name,
        game_username: a.game_username,
        game_password: a.game_password,
        company_entity_id: a.company_entity_id ?? auth.companyId ?? null,
        note: a.note,
        source: "bot" as const,
      })),
    )
    .onConflictDoNothing({
      target: [gameAccountPool.game_name, gameAccountPool.game_username],
    })
    .returning();

  return Response.json(
    {
      added: inserted.length,
      duplicates: incoming.length - inserted.length,
      accounts: inserted.map(poolJson),
      stock: await poolStock(),
    },
    { status: inserted.length ? 201 : 200 },
  );
}

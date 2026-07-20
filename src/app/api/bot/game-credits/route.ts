import { and, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameCredits, players, transactions } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { gameCreditJson, jsonError } from "@/lib/bot-crud";

/** GET /api/bot/game-credits?player_id=&game_name= */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const playerId = url.searchParams.get("player_id");
  const gameName = url.searchParams.get("game_name");

  const filters: SQL[] = [];
  if (playerId) filters.push(eq(gameCredits.player_id, Number(playerId)));
  if (gameName) filters.push(eq(gameCredits.game_name, gameName));

  const rows = await db
    .select()
    .from(gameCredits)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(gameCredits.last_updated_at));

  return Response.json({ count: rows.length, game_credits: rows.map(gameCreditJson) });
}

const upsertSchema = z.object({
  player_id: z.number().int().positive(),
  game_name: z.string().min(1),
  current_balance: z.number().min(0),
});

/**
 * POST /api/bot/game-credits — set (upsert) a player's balance for one game.
 * Use this to sync the actual game-provider balance into the CRM. The value is
 * absolute (a set, not a delta). The change is logged as a bo_adjustment audit row.
 */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = upsertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
  }
  const body = parsed.data;

  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.player_id, body.player_id));
  if (!player) return jsonError("Player not found", 404);

  const nowIso = new Date().toISOString();
  const [before] = await db
    .select()
    .from(gameCredits)
    .where(
      and(
        eq(gameCredits.player_id, body.player_id),
        eq(gameCredits.game_name, body.game_name),
      ),
    );

  const [row] = await db
    .insert(gameCredits)
    .values({
      player_id: body.player_id,
      game_name: body.game_name,
      current_balance: body.current_balance,
      last_updated_at: nowIso,
    })
    .onConflictDoUpdate({
      target: [gameCredits.player_id, gameCredits.game_name],
      set: { current_balance: body.current_balance, last_updated_at: nowIso },
    })
    .returning();

  await db.insert(transactions).values({
    player_id: body.player_id,
    type: "bo_adjustment",
    amount: +(body.current_balance - (before?.current_balance ?? 0)).toFixed(2),
    game_name: body.game_name,
    details: {
      action: "balance_sync",
      balance_before: before?.current_balance ?? 0,
      balance_after: body.current_balance,
      source: "bot",
    },
  });

  return Response.json({ game_credit: gameCreditJson(row) });
}

const deleteSchema = z.object({
  player_id: z.number().int().positive(),
  game_name: z.string().min(1),
});

/**
 * DELETE /api/bot/game-credits — remove a player's game-credit row.
 * Body: { player_id, game_name }. Blocked while a non-zero balance remains (422).
 */
export async function DELETE(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Provide player_id and game_name");
  const { player_id, game_name } = parsed.data;

  const [row] = await db
    .select()
    .from(gameCredits)
    .where(
      and(
        eq(gameCredits.player_id, player_id),
        eq(gameCredits.game_name, game_name),
      ),
    );
  if (!row) return jsonError("Game credit not found", 404);
  if (row.current_balance > 0) {
    return jsonError("Balance must be zero before deleting this game credit", 422);
  }

  await db
    .delete(gameCredits)
    .where(
      and(
        eq(gameCredits.player_id, player_id),
        eq(gameCredits.game_name, game_name),
      ),
    );
  return Response.json({ ok: true, deleted: { player_id, game_name } });
}

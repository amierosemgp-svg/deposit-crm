import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameCredits, gameTransfers, players, transactions } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { playerGameInfoMap } from "@/lib/bot-transactions";
import { BotError, botErrorResponse, gameTransferJson, jsonError } from "@/lib/bot-crud";

const TRANSFER_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;

/** GET /api/bot/game-transfers?player_id=&status=&limit=&offset= */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const playerId = url.searchParams.get("player_id");
  const statusParam = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const filters: SQL[] = [];
  if (playerId) filters.push(eq(gameTransfers.player_id, Number(playerId)));
  if (statusParam) {
    const wanted = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s): s is (typeof TRANSFER_STATUSES)[number] =>
        (TRANSFER_STATUSES as readonly string[]).includes(s),
      );
    // Don't silently ignore a status we don't know — that returns every
    // transfer and reads as "the filter worked, there's just nothing there".
    if (!wanted.length) {
      return jsonError(`Invalid status. Use: ${TRANSFER_STATUSES.join(", ")}`);
    }
    filters.push(inArray(gameTransfers.status, wanted));
  }

  const rows = await db
    .select()
    .from(gameTransfers)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(gameTransfers.transfer_id))
    .limit(limit)
    .offset(offset);

  const gameInfo = await playerGameInfoMap(rows.map((r) => r.player_id));
  return Response.json({
    count: rows.length,
    game_transfers: rows.map((r) =>
      gameTransferJson(r, gameInfo.get(r.player_id)),
    ),
  });
}

const createSchema = z.object({
  player_id: z.number().int().positive(),
  from_game: z.string().min(1),
  to_game: z.string().min(1),
  amount: z.number().positive(),
});

/** POST /api/bot/game-transfers — move a player's credits between games, atomically. */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
  }
  const body = parsed.data;
  if (body.from_game === body.to_game) {
    return jsonError("From and to game must differ");
  }

  try {
    const result = await db.transaction(async (txn) => {
      const [player] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, body.player_id));
      if (!player) throw new BotError(404, "Player not found");

      const [fromCredit] = await txn
        .select()
        .from(gameCredits)
        .where(
          and(
            eq(gameCredits.player_id, body.player_id),
            eq(gameCredits.game_name, body.from_game),
          ),
        )
        .for("update");
      const fromBalance = fromCredit?.current_balance ?? 0;
      if (fromBalance < body.amount) {
        throw new BotError(
          422,
          `Insufficient ${body.from_game} balance (${fromBalance.toFixed(2)})`,
        );
      }

      const nowIso = new Date().toISOString();
      await txn
        .update(gameCredits)
        .set({
          current_balance: +(fromBalance - body.amount).toFixed(2),
          last_updated_at: nowIso,
        })
        .where(
          and(
            eq(gameCredits.player_id, body.player_id),
            eq(gameCredits.game_name, body.from_game),
          ),
        );
      await txn
        .insert(gameCredits)
        .values({
          player_id: body.player_id,
          game_name: body.to_game,
          current_balance: body.amount,
          last_updated_at: nowIso,
        })
        .onConflictDoUpdate({
          target: [gameCredits.player_id, gameCredits.game_name],
          set: {
            current_balance: sql`${gameCredits.current_balance} + ${body.amount}`,
            last_updated_at: nowIso,
          },
        });

      const [transfer] = await txn
        .insert(gameTransfers)
        .values({
          player_id: body.player_id,
          from_game: body.from_game,
          to_game: body.to_game,
          transfer_amount: body.amount,
          from_game_balance_before: fromBalance,
          status: "completed",
        })
        .returning();

      await txn.insert(transactions).values({
        player_id: body.player_id,
        entity_id: player.company_entity_id,
        type: "game_transfer",
        amount: body.amount,
        game_name: `${body.from_game} → ${body.to_game}`,
        reference_id: transfer.transfer_id,
        details: { from: body.from_game, to: body.to_game, source: "bot" },
      });

      return { transfer, gameAccounts: player.game_accounts };
    });

    return Response.json(
      {
        transfer: gameTransferJson(result.transfer, {
          game_accounts: result.gameAccounts,
        }),
      },
      { status: 201 },
    );
  } catch (e) {
    return botErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

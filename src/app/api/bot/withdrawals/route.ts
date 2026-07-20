import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players, transactions, withdrawals } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { jsonError, withdrawalJson } from "@/lib/bot-crud";

const STATUSES = ["requested", "credits_pulled", "paid", "failed"] as const;

/** GET /api/bot/withdrawals?player_id=&status=&limit=&offset= */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const playerId = url.searchParams.get("player_id");
  const statusParam = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const filters: SQL[] = [];
  if (playerId) filters.push(eq(withdrawals.player_id, Number(playerId)));
  if (statusParam) {
    const wanted = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is (typeof STATUSES)[number] =>
        (STATUSES as readonly string[]).includes(s),
      );
    if (wanted.length) filters.push(inArray(withdrawals.status, wanted));
  }

  const rows = await db
    .select()
    .from(withdrawals)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(withdrawals.withdrawal_id))
    .limit(limit)
    .offset(offset);

  return Response.json({ count: rows.length, withdrawals: rows.map(withdrawalJson) });
}

const createSchema = z.object({
  player_id: z.number().int().positive(),
  requested_amount: z.number().positive(),
  game_name: z.string().min(1),
  bank_name: z.string().optional(),
  bank_account_number: z.string().optional(),
});

/** POST /api/bot/withdrawals — log a withdrawal request. Starts as "requested". */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
  }
  const body = parsed.data;

  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.player_id, body.player_id));
  if (!player) return jsonError("Player not found", 404);

  const [created] = await db
    .insert(withdrawals)
    .values({
      player_id: body.player_id,
      requested_amount: body.requested_amount,
      game_name: body.game_name,
      bank_name: body.bank_name,
      bank_account_number: body.bank_account_number,
    })
    .returning();

  await db.insert(transactions).values({
    player_id: body.player_id,
    type: "withdrawal",
    amount: body.requested_amount,
    game_name: body.game_name,
    reference_id: created.withdrawal_id,
    details: { action: "requested", source: "bot" },
  });

  return Response.json({ withdrawal: withdrawalJson(created) }, { status: 201 });
}

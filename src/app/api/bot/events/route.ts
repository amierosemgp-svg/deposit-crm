import { and, desc, eq, gt, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { botEvents } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { jsonError } from "@/lib/bot-crud";

const LEVELS = ["debug", "info", "warn", "error"] as const;

const eventSchema = z.object({
  bot_id: z.string().min(1).max(80).optional(),
  level: z.enum(LEVELS).optional(),
  event: z.string().min(1).max(80),
  message: z.string().max(4000).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  player_id: z.number().int().positive().optional(),
  game_transfer_id: z.number().int().positive().optional(),
  deposit_id: z.number().int().positive().optional(),
  withdrawal_id: z.number().int().positive().optional(),
  occurred_at: z.string().optional(),
});

// One event or a batch — a busy bot should be able to buffer and flush.
const postSchema = z.union([
  eventSchema.extend({ bot_id: z.string().min(1).max(80) }),
  z.object({
    bot_id: z.string().min(1).max(80),
    events: z.array(eventSchema).min(1).max(500),
  }),
]);

function eventJson(row: typeof botEvents.$inferSelect) {
  return {
    event_id: row.event_id,
    bot_id: row.bot_id,
    level: row.level,
    event: row.event,
    message: row.message,
    context: row.context,
    player_id: row.player_id,
    game_transfer_id: row.game_transfer_id,
    deposit_id: row.deposit_id,
    withdrawal_id: row.withdrawal_id,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  };
}

/**
 * POST /api/bot/events — the bot's live feed.
 *
 * Post what you're doing as you do it: one event, or a batch when you'd rather
 * buffer and flush. This is a fire-and-forget operational log — it never
 * changes any transaction's state, so posting is always safe and a failure
 * here should never stop the bot from working.
 *
 * `occurred_at` lets a batched flush keep the real timings; it defaults to now.
 */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      parsed.error.issues[0]?.message ??
        'Send {bot_id, event, message?} or {bot_id, events: [...]}',
    );
  }

  const botId = parsed.data.bot_id;
  const incoming =
    "events" in parsed.data ? parsed.data.events : [parsed.data];

  const inserted = await db
    .insert(botEvents)
    .values(
      incoming.map((e) => ({
        bot_id: e.bot_id ?? botId,
        level: e.level ?? ("info" as const),
        event: e.event,
        message: e.message,
        context: e.context,
        player_id: e.player_id,
        game_transfer_id: e.game_transfer_id,
        deposit_id: e.deposit_id,
        withdrawal_id: e.withdrawal_id,
        // An unparseable timestamp shouldn't lose the event — fall back to now.
        occurred_at:
          e.occurred_at && !Number.isNaN(Date.parse(e.occurred_at))
            ? new Date(e.occurred_at).toISOString()
            : new Date().toISOString(),
      })),
    )
    .returning({ event_id: botEvents.event_id });

  return Response.json({ accepted: inserted.length }, { status: 201 });
}

/**
 * GET /api/bot/events?bot_id=&level=&since_id=&game_transfer_id=&limit=
 *
 * Read the feed back. `since_id` returns only events newer than that id, which
 * is how a live view tails the feed without re-reading what it already has.
 */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const filters: SQL[] = [];

  const botId = url.searchParams.get("bot_id");
  if (botId) filters.push(eq(botEvents.bot_id, botId));

  const sinceId = Number(url.searchParams.get("since_id"));
  if (Number.isInteger(sinceId) && sinceId > 0) {
    filters.push(gt(botEvents.event_id, sinceId));
  }

  for (const [param, column] of [
    ["game_transfer_id", botEvents.game_transfer_id],
    ["deposit_id", botEvents.deposit_id],
    ["withdrawal_id", botEvents.withdrawal_id],
    ["player_id", botEvents.player_id],
  ] as const) {
    const raw = Number(url.searchParams.get(param));
    if (Number.isInteger(raw) && raw > 0) filters.push(eq(column, raw));
  }

  const levelParam = url.searchParams.get("level");
  if (levelParam) {
    const wanted = levelParam
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is (typeof LEVELS)[number] =>
        (LEVELS as readonly string[]).includes(s),
      );
    if (!wanted.length) {
      return jsonError(`Invalid level. Use: ${LEVELS.join(", ")}`);
    }
    filters.push(inArray(botEvents.level, wanted));
  }

  const rows = await db
    .select()
    .from(botEvents)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(botEvents.event_id))
    .limit(limit);

  return Response.json({
    count: rows.length,
    // The caller's next `since_id`. Taken from the highest id returned, so a
    // tail can't skip events that arrived while this query ran.
    latest_id: rows.length ? rows[0].event_id : (sinceId || 0),
    events: rows.map(eventJson),
  });
}

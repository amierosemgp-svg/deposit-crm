import { and, desc, eq, gt, inArray, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { botEvents } from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const LEVELS = ["debug", "info", "warn", "error"] as const;

/**
 * GET /api/bot-events?since_id=&level=&bot_id=&limit= — the bot's live feed,
 * for logged-in CRM users.
 *
 * Separate from /api/state so the feed can be tailed quickly with `since_id`
 * without dragging the whole application state along with it.
 */
export async function GET(request: Request) {
  try {
    await requireUser();

    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 300);
    const filters: SQL[] = [];

    const botId = url.searchParams.get("bot_id");
    if (botId) filters.push(eq(botEvents.bot_id, botId));

    const sinceId = Number(url.searchParams.get("since_id"));
    if (Number.isInteger(sinceId) && sinceId > 0) {
      filters.push(gt(botEvents.event_id, sinceId));
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
      latest_id: rows.length ? rows[0].event_id : (sinceId || 0),
      events: rows,
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

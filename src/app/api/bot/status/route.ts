import { desc } from "drizzle-orm";
import { db } from "@/db";
import { botHealth } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";

const ONLINE_MS = 90 * 1000;

/**
 * GET /api/bot/status — latest health of every bot. `online` is derived:
 * a bot is online if its last heartbeat was within 90s. When offline it is
 * shown as offline regardless of its last reported state.
 */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const rows = await db
    .select()
    .from(botHealth)
    .orderBy(desc(botHealth.last_heartbeat_at));

  const now = Date.now();
  const bots = rows.map((r) => ({
    bot_id: r.bot_id,
    state: r.state,
    step: r.step,
    last_heartbeat: r.last_heartbeat_at,
    last_transaction_at: r.last_transaction_at,
    online: now - new Date(r.last_heartbeat_at).getTime() < ONLINE_MS,
    error: r.error,
  }));

  return Response.json({ bots });
}

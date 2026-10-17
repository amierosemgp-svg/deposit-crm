import { and, eq, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { players } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { scopeTo } from "@/lib/bot-scope";

/**
 * GET /api/bot/members?telegram_username=@ahmadtan88
 * GET /api/bot/members?player_id=1001
 * GET /api/bot/members?q=Ahmad          (name / username search)
 * Agent use-case #4: verify a member exists before creating a transaction.
 */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const telegram = url.searchParams.get("telegram_username");
  const playerId = url.searchParams.get("player_id");
  const q = url.searchParams.get("q");

  if (!telegram && !playerId && !q) {
    return Response.json(
      { error: "Provide telegram_username, player_id, or q" },
      { status: 400 },
    );
  }

  // A casino-scoped key only finds its own casino's members.
  const scope = scopeTo(auth, players.company_entity_id);

  let rows;
  if (playerId) {
    rows = await db
      .select()
      .from(players)
      .where(and(eq(players.player_id, Number(playerId)), scope));
  } else if (telegram) {
    const handle = telegram.startsWith("@") ? telegram : `@${telegram}`;
    rows = await db
      .select()
      .from(players)
      .where(and(ilike(players.telegram_username, handle), scope));
  } else {
    rows = await db
      .select()
      .from(players)
      .where(
        and(
          or(
            ilike(players.username, `%${q}%`),
            ilike(players.full_name, `%${q}%`),
          ),
          scope,
        ),
      )
      .limit(20);
  }

  return Response.json({
    count: rows.length,
    members: rows.map((p) => ({
      player_id: p.player_id,
      username: p.username,
      full_name: p.full_name,
      telegram_username: p.telegram_username,
      wechat_id: p.wechat_id,
      company_entity_id: p.company_entity_id,
      status: p.status,
      registration_date: p.registration_date,
    })),
  });
}

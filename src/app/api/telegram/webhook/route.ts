import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logActivity } from "@/lib/activity-log";
import { consumeLinkToken } from "@/lib/two-factor";
import { sendTelegramMessage } from "@/lib/telegram";

/**
 * POST /api/telegram/webhook — where the enrolment bot's updates land.
 *
 * The only message this cares about is `/start <token>`, which is what the
 * deep link on the Security screen produces. Redeeming the token is how the
 * CRM learns a user's chat id; everything else gets a polite nudge.
 *
 * Telegram authenticates itself with the secret header set when the webhook
 * was registered (`secret_token` on setWebhook). Without TELEGRAM_WEBHOOK_SECRET
 * configured the route refuses outright rather than trusting the caller —
 * anyone on the internet can POST here.
 *
 * It always answers 200 once authenticated: a non-200 makes Telegram retry the
 * same update for hours, and a token that has already been spent will never
 * succeed on a retry.
 */

type Update = {
  message?: {
    text?: string;
    chat?: { id?: number | string };
    from?: { username?: string };
  };
};

export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: "Not configured" }, { status: 503 });
  }
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const update = (await request.json().catch(() => null)) as Update | null;
  const text = update?.message?.text?.trim() ?? "";
  const chatId = update?.message?.chat?.id;
  const handle = update?.message?.from?.username ?? null;
  if (!chatId) return Response.json({ ok: true });
  const chat = String(chatId);

  const match = /^\/start\s+([0-9a-f]{48})$/i.exec(text);
  if (!match) {
    await sendTelegramMessage(
      chat,
      "Open the link from the Players Console Security page to connect this chat.",
    );
    return Response.json({ ok: true });
  }

  const challenge = await consumeLinkToken(match[1].toLowerCase());
  if (!challenge) {
    await sendTelegramMessage(
      chat,
      "That link has expired. Generate a new one on the Security page and open it again.",
    );
    return Response.json({ ok: true });
  }

  // One Telegram account drives one login: leaving a chat attached to two
  // users would send each of them the other's codes.
  const [claimed] = await db
    .select({ user_id: users.user_id })
    .from(users)
    .where(eq(users.telegram_chat_id, chat));
  if (claimed && claimed.user_id !== challenge.user_id) {
    await sendTelegramMessage(
      chat,
      "This Telegram account is already connected to another Players Console login. Unlink it there first.",
    );
    return Response.json({ ok: true });
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.user_id, challenge.user_id));
  if (!user || user.status !== "active") return Response.json({ ok: true });

  await db
    .update(users)
    .set({
      telegram_chat_id: chat,
      telegram_username: handle,
      updated_at: new Date().toISOString(),
    })
    .where(eq(users.user_id, user.user_id));

  await logActivity({
    category: "auth",
    action: "auth.telegram_linked",
    summary: `${user.full_name} linked Telegram${handle ? ` (@${handle})` : ""} for sign-in codes`,
    actorUserId: user.user_id,
    actorLabel: user.username,
    targetType: "user",
    targetId: user.user_id,
    targetLabel: user.username,
  });

  await sendTelegramMessage(
    chat,
    `Connected to Players Console as ${user.full_name}.\n\n` +
      `Turn on two-factor sign-in from the Security page and your codes will arrive here.`,
  );
  return Response.json({ ok: true });
}

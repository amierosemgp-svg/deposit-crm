import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity, requestContext } from "@/lib/activity-log";
import { issueLinkToken, LINK_TTL_MINUTES } from "@/lib/two-factor";
import { telegramBotUsername, telegramConfigured } from "@/lib/telegram";

/**
 * Telegram enrolment and the 2FA switch, both for the signed-in user only.
 *
 * Nobody knows their own Telegram chat id, so it can't be typed into a form.
 * Instead this hands back a one-shot deep link; opening it sends the bot
 * `/start <token>`, and the webhook writes the chat id back against the user.
 */

/** GET — the current state of my second factor, and a fresh link to enrol. */
export async function GET() {
  try {
    const me = await requireUser();
    const [row] = await db
      .select({
        chat: users.telegram_chat_id,
        handle: users.telegram_username,
        enabled: users.two_factor_enabled,
      })
      .from(users)
      .where(eq(users.user_id, me.user_id));

    const bot = telegramBotUsername();
    const configured = telegramConfigured() && Boolean(bot);
    // Only mint a token when there's a bot to carry it to.
    const token = configured && !row?.chat ? await issueLinkToken(me.user_id) : null;

    return Response.json({
      configured,
      bot_username: bot,
      linked: Boolean(row?.chat),
      telegram_username: row?.handle ?? null,
      two_factor_enabled: row?.enabled ?? false,
      link_url: token ? `https://t.me/${bot}?start=${token}` : null,
      link_expires_minutes: LINK_TTL_MINUTES,
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

const patchSchema = z.object({ two_factor_enabled: z.boolean() });

/** PATCH — turn my own second factor on or off. */
export async function PATCH(request: Request) {
  try {
    const me = await requireUser();
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Send two_factor_enabled");
    const { two_factor_enabled } = parsed.data;

    const [row] = await db
      .select({ chat: users.telegram_chat_id, full_name: users.full_name })
      .from(users)
      .where(eq(users.user_id, me.user_id));

    // Turning it on without a chat linked would lock the account behind a
    // code with nowhere to arrive.
    if (two_factor_enabled && !row?.chat) {
      throw new AuthError(400, "Link your Telegram before turning on two-factor sign-in");
    }

    await db
      .update(users)
      .set({ two_factor_enabled, updated_at: new Date().toISOString() })
      .where(eq(users.user_id, me.user_id));

    await logActivity({
      category: "auth",
      action: two_factor_enabled ? "auth.two_factor_enabled" : "auth.two_factor_disabled",
      summary: `${row?.full_name ?? me.full_name} turned two-factor sign-in ${two_factor_enabled ? "on" : "off"}`,
      actorUserId: me.user_id,
      actorLabel: me.username,
      targetType: "user",
      targetId: me.user_id,
      targetLabel: me.username,
      context: requestContext(request),
    });

    return Response.json({ two_factor_enabled });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/** DELETE — unlink Telegram. Takes 2FA down with it, for the same reason. */
export async function DELETE(request: Request) {
  try {
    const me = await requireUser();
    await db
      .update(users)
      .set({
        telegram_chat_id: null,
        telegram_username: null,
        two_factor_enabled: false,
        updated_at: new Date().toISOString(),
      })
      .where(eq(users.user_id, me.user_id));

    await logActivity({
      category: "auth",
      action: "auth.telegram_unlinked",
      summary: `${me.full_name} unlinked their Telegram — two-factor sign-in is off`,
      actorUserId: me.user_id,
      actorLabel: me.username,
      targetType: "user",
      targetId: me.user_id,
      targetLabel: me.username,
      context: requestContext(request),
    });

    return Response.json({ linked: false, two_factor_enabled: false });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

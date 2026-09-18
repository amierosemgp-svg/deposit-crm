/**
 * Sending to Telegram — the second factor's delivery route.
 *
 * One bot, named by TELEGRAM_BOT_TOKEN, DMs each user their login code. There
 * is no inbound polling here: the bot's own updates arrive at the webhook
 * route, which is what enrolment listens on.
 *
 * Every function is soft-failing by design. Telegram being down must read as
 * "the code didn't send, try again", never as a 500 on the login route — the
 * caller decides what to tell the user.
 */

/** Overridable so a test can point the bot at a local stub. */
const API = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";

export type TelegramResult =
  | { ok: true }
  | { ok: false; error: string };

/** Configured = a bot token is present. Without one, 2FA can't be enrolled. */
export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

/** The bot's @name, for the deep link the enrolment screen shows. */
export function telegramBotUsername(): string | null {
  return process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") ?? null;
}

async function callBot(
  method: string,
  payload: Record<string, unknown>,
): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: "Telegram is not configured" };
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // A hung Telegram must not hold the login request open.
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string }
      | null;
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.description ?? `Telegram HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not reach Telegram",
    };
  }
}

/** Plain-text DM. Markdown is deliberately off — codes shouldn't be parsed. */
export function sendTelegramMessage(
  chatId: string,
  text: string,
): Promise<TelegramResult> {
  return callBot("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

/**
 * The login code, worded so a user who didn't ask for it knows to worry.
 * The code is on its own line to make it easy to copy on a phone.
 */
export function sendLoginCode(
  chatId: string,
  code: string,
  context: { ip?: string | null; minutes: number },
): Promise<TelegramResult> {
  const where = context.ip ? `\nFrom: ${context.ip}` : "";
  return sendTelegramMessage(
    chatId,
    `Players Console sign-in code\n\n${code}\n\n` +
      `Expires in ${context.minutes} minutes.${where}\n\n` +
      `If this wasn't you, don't enter it — someone has your password. Tell an admin.`,
  );
}

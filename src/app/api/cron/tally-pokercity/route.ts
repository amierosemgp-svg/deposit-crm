import { db } from "@/db";
import { runPokercityTally } from "@/lib/pokercity-tally";
import { chunkMessage } from "@/lib/sheet-tally";
import { sendTelegramMessage } from "@/lib/telegram";

/**
 * GET /api/cron/tally-pokercity — Vercel Cron target (see vercel.json), 06:00
 * Malaysian time. Checks Pokercity's Google Sheet against the CRM for the day
 * before, and the month so far, and posts what doesn't agree to Telegram.
 *
 * The sheet is a new file each month, found by name: "Poker City Transaction
 * <Month> <Year>", shared with the service account as Viewer. A month nobody
 * has shared yet is reported as that, not as silence.
 *
 * Query parameters, for running it by hand:
 *   date=YYYY-MM-DD  check that day instead of yesterday
 *   sheet=<id>       use this spreadsheet instead of looking it up by name
 *   send=0           don't post to Telegram, just return the report
 *
 * Posts to TALLY_TELEGRAM_CHAT_ID; without it the report is only returned.
 */

/** Yesterday, Malaysian time. */
function yesterday(): string {
  const now = new Date(Date.now() + 8 * 3600_000 - 24 * 3600_000);
  return now.toISOString().slice(0, 10);
}

async function post(text: string, send: boolean) {
  const chatId = process.env.TALLY_TELEGRAM_CHAT_ID;
  if (!send || !chatId) return { sent: false };
  for (const part of chunkMessage(text)) {
    const r = await sendTelegramMessage(chatId, part);
    if (!r.ok) return { sent: false, error: r.error };
  }
  return { sent: true };
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (header !== `Bearer ${secret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const params = new URL(request.url).searchParams;
  const day = params.get("date") ?? yesterday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  const send = params.get("send") !== "0";

  try {
    const result = await runPokercityTally(db, day, { sheetId: params.get("sheet") });
    return Response.json({ ...result, ...(await post(result.text, send)) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const text = `Pokercity sheet vs CRM — couldn't run for ${day}.\n\n${message}`;
    return Response.json({ ok: false, day, error: message, ...(await post(text, send)) }, { status: 500 });
  }
}

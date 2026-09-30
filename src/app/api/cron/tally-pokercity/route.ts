import { db } from "@/db";
import { googleClientEmail, googleSheets } from "@/lib/google-sheets";
import {
  MONTHS,
  buildReport,
  chunkMessage,
  loadCrmRows,
  parseTab,
  reconcile,
} from "@/lib/sheet-tally";
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

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

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
  const [year, month] = day.split("-").map(Number);
  const monthName = MONTHS[month - 1];

  try {
    const google = await googleSheets();

    let sheetId = params.get("sheet");
    let sheetName = sheetId ?? "";
    if (!sheetId) {
      const files = await google.findSpreadsheets(["Poker", "Transaction", monthName, String(year)]);
      if (!files.length) {
        const text =
          `Pokercity sheet vs CRM — couldn't run for ${day}.\n\n` +
          `No Google Sheet named like "Poker City Transaction ${monthName} ${year}" is shared with ` +
          `${googleClientEmail()}. Share this month's file with that email as Viewer.`;
        return Response.json({ ok: false, day, text, ...(await post(text, send)) });
      }
      sheetId = files[0].id;
      sheetName = files[0].name;
    }

    const [depGrid, wdrGrid] = await Promise.all([
      google.readTab(sheetId, "+Deposit"),
      google.readTab(sheetId, "-Withdrawal"),
    ]);
    const sheet = [
      ...parseTab(depGrid, "deposit", year, month),
      ...parseTab(wdrGrid, "withdrawal", year, month),
    ];

    // A margin either side of the month, so an entry near midnight on the 1st
    // or the last day can still find its partner.
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const crm = await loadCrmRows(db, addDays(monthStart, -2), addDays(day, 3));

    const findings = reconcile(sheet, crm, day);
    const text = buildReport({ day, sheetName, sheet, crm, findings });
    const onDay = findings.filter((f) => ("s" in f ? f.s.day : f.c.day) === day).length;
    return Response.json({
      ok: true,
      day,
      sheet: sheetName,
      toCheck: onDay,
      stillOpen: findings.length - onDay,
      text,
      ...(await post(text, send)),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const text = `Pokercity sheet vs CRM — couldn't run for ${day}.\n\n${message}`;
    return Response.json({ ok: false, day, error: message, ...(await post(text, send)) }, { status: 500 });
  }
}

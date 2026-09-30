import type { db as Db } from "@/db";
import { googleClientEmail, googleSheets } from "@/lib/google-sheets";
import {
  MONTHS,
  buildReport,
  findingDay,
  loadCrmRows,
  needsAction,
  parseTab,
  reconcile,
  type SheetRow,
} from "@/lib/sheet-tally";

/**
 * One run of the Pokercity sheet-vs-CRM check, for one day. The cron route
 * wraps this with auth and Telegram; kept apart so it can be run by hand
 * against any database handle.
 */

/** How far across a month boundary an entry can sit and still pair up. */
const MARGIN_DAYS = 2;

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

const fileWords = (year: number, month: number) => [
  "Poker",
  "Transaction",
  MONTHS[month - 1],
  String(year),
];

export type TallyResult =
  | { ok: true; day: string; sheet: string; toCheck: number; stillOpen: number; text: string }
  | { ok: false; day: string; text: string };

export async function runPokercityTally(
  db: typeof Db,
  day: string,
  opts: { sheetId?: string | null } = {},
): Promise<TallyResult> {
  const [year, month] = day.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const google = await googleSheets();

  const readSheet = async (id: string, y: number, m: number): Promise<SheetRow[]> => {
    const [dep, wdr] = await Promise.all([
      google.readTab(id, "+Deposit"),
      google.readTab(id, "-Withdrawal"),
    ]);
    return [...parseTab(dep, "deposit", y, m), ...parseTab(wdr, "withdrawal", y, m)];
  };

  let sheetId = opts.sheetId ?? null;
  let sheetName = sheetId ?? "";
  if (!sheetId) {
    const [file] = await google.findSpreadsheets(fileWords(year, month));
    if (!file) {
      return {
        ok: false,
        day,
        text:
          `Pokercity sheet vs CRM — couldn't run for ${day}.\n\n` +
          `No Google Sheet named like "Poker City Transaction ${MONTHS[month - 1]} ${year}" ` +
          `is shared with ${googleClientEmail()}. Share this month's file with that email as Viewer.`,
      };
    }
    sheetId = file.id;
    sheetName = file.name;
  }
  const sheet = await readSheet(sheetId, year, month);

  // Early in the month, last month's final rows are in last month's file. Read
  // them so a CRM entry just after midnight on the 1st finds its sheet row
  // there. Only for pairing: nothing before monthStart is reported.
  const notes: string[] = [];
  if (day < addDays(monthStart, MARGIN_DAYS)) {
    const py = month === 1 ? year - 1 : year;
    const pm = month === 1 ? 12 : month - 1;
    try {
      const [prev] = await google.findSpreadsheets(fileWords(py, pm));
      if (!prev) throw new Error("not shared");
      const edge = addDays(monthStart, -MARGIN_DAYS);
      sheet.push(...(await readSheet(prev.id, py, pm)).filter((r) => r.day >= edge));
    } catch {
      notes.push(
        `(Couldn't read ${MONTHS[pm - 1]}'s sheet, so an entry just after midnight on the 1st may show up here.)`,
      );
    }
  }

  const crm = await loadCrmRows(db, addDays(monthStart, -MARGIN_DAYS), addDays(day, 3));
  const findings = reconcile(sheet, crm, monthStart, day);
  const text = buildReport({ day, sheetName, sheet, crm, findings, notes });
  const open = findings.filter(needsAction);
  const toCheck = open.filter((f) => findingDay(f) === day).length;
  return { ok: true, day, sheet: sheetName, toCheck, stillOpen: open.length - toCheck, text };
}

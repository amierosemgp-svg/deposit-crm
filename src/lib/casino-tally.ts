import { sql } from "drizzle-orm";
import type { db as Db } from "@/db";
import { googleClientEmail, googleSheets } from "@/lib/google-sheets";
import {
  MONTHS,
  buildReport,
  countUndated,
  dayLabel,
  findingDay,
  loadCrmRows,
  needsAction,
  parseTab,
  reconcile,
  type CrmRow,
  type Finding,
  type Kind,
  type SheetRow,
} from "@/lib/sheet-tally";

/**
 * One run of the sheet-vs-CRM check, for one casino and one day. The cron
 * route wraps this with auth and email; kept apart so it can be run by hand
 * against any database handle.
 */

/**
 * A casino whose sheet is checked every morning.
 *
 * `entity` pins the CRM company by id, or names it so it's looked up in
 * `entities` (company rows only, compared ignoring case, spaces and
 * punctuation — "Robin Hood" finds "RobinHood").
 *
 * `sheet` is one fixed file, or a new file each month found by the words in
 * its name. Either way the file must be shared with the service account as
 * Viewer.
 *
 * `requireBonus` makes a deposit tab without a Bonus column an error. Without
 * it, a sheet that doesn't keep bonuses just isn't checked for them.
 *
 * `paused` keeps a casino out of the morning email, with the reason. It can
 * still be run by hand with ?company=<key>.
 */
export type TallyCompany = {
  key: string; // ?company=<key> runs just this one
  name: string;
  entity: { id: number } | { names: string[] };
  sheet:
    | { id: string }
    | { monthly: (month: string, year: number) => { words: string[]; like: string } };
  requireBonus?: boolean;
  paused?: string;
};

/**
 * Each casino keeps a new file a month, named "<Casino> Transaction <Month>
 * <Year>". Drive's "name contains" matches word prefixes, so "Robin" finds
 * "RobinHood".
 */
const monthlyFile = (words: string[], label: string) => ({
  monthly: (month: string, year: number) => ({
    words: [...words, "Transaction", month, String(year)],
    like: `${label} Transaction ${month} ${year}`,
  }),
});

export const TALLY_COMPANIES: TallyCompany[] = [
  {
    key: "pokercity",
    name: "Pokercity",
    entity: { id: 30 },
    sheet: monthlyFile(["Poker"], "Poker City"),
    requireBonus: true,
  },
  {
    key: "fishingstar",
    name: "Fishing Star",
    entity: { names: ["Fishing Star"] },
    sheet: monthlyFile(["Fishing", "Star"], "Fishing Star"),
    paused: "no deposits in the CRM yet",
  },
  {
    key: "robinhood",
    name: "Robin Hood",
    entity: { names: ["Robin Hood"] },
    sheet: monthlyFile(["Robin"], "RobinHood"),
  },
  {
    key: "genting",
    name: "Genting Casino",
    entity: { names: ["Genting Casino", "Genting"] },
    sheet: monthlyFile(["Genting"], "Genting Casino"),
    paused: "no deposits in the CRM yet",
  },
];

/** How far across a month boundary an entry can sit and still pair up. */
const MARGIN_DAYS = 2;

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The CRM company entity a TallyCompany refers to; throws when it isn't exactly one. */
export async function resolveCompanyEntity(db: typeof Db, company: TallyCompany): Promise<number> {
  if ("id" in company.entity) return company.entity.id;
  const wanted = new Set(company.entity.names.map(squash));
  const res = await db.execute(sql`
    SELECT entity_id, name, status::text AS status FROM entities WHERE entity_type = 'company'
  `);
  const all = (res.rows as { entity_id: number; name: string; status: string }[]).filter((e) =>
    wanted.has(squash(e.name)),
  );
  const active = all.filter((e) => e.status === "active");
  const hits = active.length ? active : all;
  if (hits.length === 1) return Number(hits[0].entity_id);
  if (!hits.length) {
    throw new Error(
      `No company named ${company.entity.names.map((n) => `"${n}"`).join(" or ")} in the CRM.`,
    );
  }
  throw new Error(
    `More than one CRM company is named like "${company.name}": ` +
      hits.map((e) => `${e.name} (#${e.entity_id})`).join(", ") +
      ". Pin the right one by id in TALLY_COMPANIES.",
  );
}

/**
 * The tab holding `kind`'s rows: "+Deposit" / "-Withdrawal" when they exist,
 * otherwise the tab named plainly "Deposit" / "Withdrawal", otherwise the
 * first whose name says deposit / withdraw.
 */
export function pickTab(tabs: string[], kind: Kind): string {
  const exact = kind === "deposit" ? "+Deposit" : "-Withdrawal";
  if (tabs.includes(exact)) return exact;
  const word = kind === "deposit" ? "deposit" : "withdraw";
  const found =
    tabs.find((t) => squash(t).replace(/\d/g, "") === (kind === "deposit" ? "deposit" : "withdrawal")) ??
    tabs.find((t) => squash(t).includes(word));
  if (!found) {
    throw new Error(`No ${kind} tab — expected one named like "${exact}". Tabs: ${tabs.join(", ")}`);
  }
  return found;
}

/** The CRM leader running a casino, whose PDF its section goes in. */
export type Leader = { id: number; name: string };

/** Everything one run matched, for the PDF to lay out beyond the email's text. */
export type TallyData = {
  monthStart: string;
  sheet: SheetRow[];
  crm: CrmRow[];
  findings: Finding[];
  notes: string[];
  withdrawals: boolean;
};

export type TallyResult =
  | {
      ok: true;
      day: string;
      sheet: string;
      toCheck: number;
      stillOpen: number;
      text: string;
      leader: Leader | null;
      data: TallyData;
    }
  | { ok: false; day: string; text: string; leader?: Leader | null };

/** The casino's current leader: the live primary row in company_leaders. */
export async function leaderOf(db: typeof Db, entityId: number): Promise<Leader | null> {
  const res = await db.execute(sql`
    SELECT l.entity_id, l.name
      FROM company_leaders cl JOIN entities l ON l.entity_id = cl.leader_entity_id
     WHERE cl.company_entity_id = ${entityId}
       AND cl.valid_from <= now() AND (cl.valid_to IS NULL OR cl.valid_to > now())
     ORDER BY cl.is_primary DESC, cl.valid_from DESC
     LIMIT 1
  `);
  const r = res.rows[0] as { entity_id: number; name: string } | undefined;
  return r ? { id: Number(r.entity_id), name: String(r.name).replace(/\s+/g, " ").trim() } : null;
}

type Google = Awaited<ReturnType<typeof googleSheets>>;

export async function runTally(
  db: typeof Db,
  company: TallyCompany,
  day: string,
  opts: { sheetId?: string | null; google?: Google } = {},
): Promise<TallyResult> {
  const [year, month] = day.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const py = month === 1 ? year - 1 : year;
  const pm = month === 1 ? 12 : month - 1;
  const google = opts.google ?? (await googleSheets());
  const shareWith = googleClientEmail() ?? "the service account";

  const entityId = await resolveCompanyEntity(db, company);
  const leader = await leaderOf(db, entityId);
  const failed = (why: string): TallyResult => ({
    ok: false,
    day,
    leader,
    text: `${company.name} tally · ${dayLabel(day)} — ❌ couldn't run\n${why}`,
  });

  /** Both tabs of one file, read once; parse them for whichever month. */
  const openSheet = async (id: string) => {
    let meta: { title: string; tabs: string[] };
    try {
      meta = await google.describe(id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`Can't open the sheet (${message}). Share it with ${shareWith} as Viewer.`);
    }
    const [dep, wdr] = await Promise.all([
      google.readTab(id, pickTab(meta.tabs, "deposit")),
      google.readTab(id, pickTab(meta.tabs, "withdrawal")),
    ]);
    const parse = (y: number, m: number): SheetRow[] => [
      ...parseTab(dep, "deposit", y, m, { requireBonus: company.requireBonus }),
      ...parseTab(wdr, "withdrawal", y, m),
    ];
    return { title: meta.title, parse, undatedWithdrawals: countUndated(wdr, "withdrawal") };
  };

  const findMonthly = async (y: number, m: number) => {
    if (!("monthly" in company.sheet)) return null;
    const { words, like } = company.sheet.monthly(MONTHS[m - 1], y);
    const [file] = await google.findSpreadsheets(words);
    return { file, like };
  };

  let sheetId = opts.sheetId ?? ("id" in company.sheet ? company.sheet.id : null);
  if (!sheetId) {
    const found = await findMonthly(year, month);
    if (!found?.file) {
      return failed(`Sheet "${found?.like}" not found. Share it with ${shareWith} as Viewer.`);
    }
    sheetId = found.file.id;
  }
  let file: Awaited<ReturnType<typeof openSheet>>;
  try {
    file = await openSheet(sheetId);
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
  let sheet = file.parse(year, month);
  // A withdrawal tab whose rows have no dates can't be checked. Leave
  // withdrawals out on both sides and say so, rather than reporting every CRM
  // withdrawal as "not on the sheet".
  const withdrawals = !(file.undatedWithdrawals > 0 && !sheet.some((r) => r.kind === "withdrawal"));
  const notes: string[] = [];
  if (!withdrawals) {
    sheet = sheet.filter((r) => r.kind === "deposit");
    notes.push(`(Withdrawals not checked: ${file.undatedWithdrawals} rows on the sheet have no date.)`);
  }
  // Nothing readable for the month means the wrong file or an unreadable date
  // column; listing every CRM row as "not on the sheet" would bury that.
  if (!sheet.length) {
    return failed(
      `"${file.title}" has no deposits or withdrawals dated ${MONTHS[month - 1]} ${year} that could be read. ` +
        `If ${MONTHS[month - 1]} is kept in a new file, point TALLY_COMPANIES at it.`,
    );
  }

  // Early in the month, last month's final rows are needed so a CRM entry just
  // after midnight on the 1st finds its sheet row. A monthly casino keeps them
  // in last month's file; a fixed sheet has them in the same one. Only for
  // pairing: nothing before monthStart is reported.
  if (day < addDays(monthStart, MARGIN_DAYS)) {
    const edge = addDays(monthStart, -MARGIN_DAYS);
    try {
      let prev = file;
      if ("monthly" in company.sheet && !opts.sheetId) {
        const found = await findMonthly(py, pm);
        if (!found?.file) throw new Error("not shared");
        prev = await openSheet(found.file.id);
      }
      sheet.push(...prev.parse(py, pm).filter((r) => r.day >= edge && (withdrawals || r.kind === "deposit")));
    } catch {
      notes.push(`(${MONTHS[pm - 1]} sheet not found; entries just after midnight on the 1st may show.)`);
    }
  }

  const crm = (await loadCrmRows(db, entityId, addDays(monthStart, -MARGIN_DAYS), addDays(day, 3))).filter(
    (c) => withdrawals || c.kind === "deposit",
  );
  const findings = reconcile(sheet, crm, monthStart, day);
  const text = buildReport({ company: company.name, day, sheet, crm, findings, notes, withdrawals });
  const open = findings.filter(needsAction);
  const toCheck = open.filter((f) => findingDay(f) === day).length;
  return {
    ok: true,
    day,
    sheet: file.title,
    toCheck,
    stillOpen: open.length - toCheck,
    text,
    leader,
    data: { monthStart, sheet, crm, findings, notes, withdrawals },
  };
}

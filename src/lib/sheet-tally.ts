import { sql } from "drizzle-orm";
import type { db as Db } from "@/db";
import { BUSINESS_TZ } from "@/lib/report-sql";

/**
 * The daily check of each casino's own Google Sheet against the CRM.
 *
 * Each casino's staff keep every deposit and withdrawal in a sheet alongside
 * keying them into the CRM (which casinos, and where their sheets are, is
 * TALLY_COMPANIES in casino-tally.ts). The two drift: a row typed in one
 * place and not the other, a wrong member code, an amount mistyped, a deposit
 * left sitting at "processing". This finds those, row by row.
 *
 * Why row by row and not day totals: day totals are mostly noise. A deposit at
 * 23:40 is filed under tomorrow on the sheet and today in the CRM; a batch
 * keyed in late carries the time it was keyed. Totals then disagree on two days
 * that are both right. Matching each sheet row to the nearest CRM entry for the
 * same member and amount (within MATCH_WINDOW) absorbs all of that, and what's
 * left over is what actually disagrees.
 *
 * Everything here is pure except loadCrmRows, so it can be run against any
 * grid and any list of rows.
 */

/** How far apart the sheet's time and the CRM's can be and still be one entry. */
const MATCH_WINDOW_MIN = 36 * 60;

/** Bank movements, not a player's money — they live in bank_cash_outs, not here. */
const NON_GAME = new Set(["clear bank", "bank charge", "expenses"]);
/** Deposit-sheet "banks" that are internal credit, never a bank credit. */
const PSEUDO_BANKS = new Set(["rekemen", "id to id"]);

export type Kind = "deposit" | "withdrawal";

export type SheetRow = {
  kind: Kind;
  row: number; // 1-based sheet row, for "row 4101" in the report
  day: string; // YYYY-MM-DD
  time: string | null; // HH:MM, null when the cell isn't a readable time
  code: string;
  cents: number;
  // Deposits only; 0 on withdrawals and a blank cell. null when the tab has
  // no Bonus column at all, and then bonuses aren't compared.
  bonusCents: number | null;
  bank: string;
  product: string;
};

export type CrmRow = {
  kind: Kind;
  id: number;
  day: string;
  time: string | null;
  code: string;
  cents: number;
  bonusCents: number;
  bank: string;
  status: string;
};

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ── parsing the sheet ───────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The sheet's date cell, as displayed, to a day of this month — or null.
 *
 * The column is a mix. Staff type "1/9/2026" meaning 1 September, into a sheet
 * whose locale reads m/d: days 1–12 become real dates in January…December that
 * DISPLAY as "1/9/2026", and 13 onwards stay text. Either way the display is
 * day/month, which is why this reads the display and not the value. A date
 * someone entered properly shows month/day, and is read that way.
 *
 * The other casinos' sheets may format dates their own way, so "1-9-2026",
 * "1.9.26", "2026/09/01", "1 Sep 2026" and "1-Sep-2026" are read too, and a
 * trailing time ("1/9/2026 14:05:00") is ignored.
 */
export function parseSheetDay(cell: string, year: number, month: number): string | null {
  const s = cell.trim().replace(/[\sT]+\d{1,2}:\d{2}(:\d{2})?(\s*[ap]m)?$/i, "");
  const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  let day: number | null = null;
  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  const num = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/);
  const named = s.match(/^(\d{1,2})[\s-]+([a-z]{3,})[\s,-]+(\d{4}|\d{2})$/i);
  if (iso) {
    if (+iso[1] === year && +iso[2] === month) day = +iso[3];
  } else if (num) {
    if (fullYear(num[3]) !== year) return null;
    if (+num[2] === month) day = +num[1];
    else if (+num[1] === month) day = +num[2];
  } else if (named) {
    if (fullYear(named[3]) !== year) return null;
    const m = MONTHS.findIndex((x) => x.slice(0, 3).toLowerCase() === named[2].slice(0, 3).toLowerCase());
    if (m + 1 === month) day = +named[1];
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day == null || day < 1 || day > last) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "2355", "122", "23:55" → "23:55" / "01:22". */
export function parseSheetTime(cell: string): string | null {
  const s = cell.trim().replace(/[:.]/g, "");
  if (!/^\d{1,4}$/.test(s)) return null;
  const v = Number(s);
  const hh = Math.floor(v / 100);
  const mm = v % 100;
  return hh < 24 && mm < 60 ? `${pad(hh)}:${pad(mm)}` : null;
}

/** "1,250.00" / "RM 50" → cents; 0 when it isn't a number. */
export function parseCents(cell: string): number {
  const n = Number(cell.replace(/rm|,|\s/gi, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * A +Deposit or -Withdrawal tab to rows.
 *
 * The header is found by its labels, not a fixed row: this month it's row 15
 * on one tab and row 12 on the other, and the block above it (bank balances,
 * targets, a lookup box) grows and shrinks. Rows without a readable date are
 * the drag-filled padding at the bottom, or that block, and are skipped.
 *
 * Only Date, Member Code and Amount are required, each under any of the names
 * in HEADERS (the casinos don't all label them alike). Product and Bank filter
 * out non-player rows when the tab has them; Time sharpens matching when it
 * has that. Bonus is compared when the deposit tab has it, and `requireBonus`
 * makes its absence an error rather than a quietly skipped check.
 */
const HEADERS = {
  date: ["date", "tarikh"],
  time: ["time", "masa"],
  code: ["member code", "member id", "member", "username", "user name", "user id", "login id", "login", "id"],
  product: ["product", "game"],
  bank: ["bank"],
  amount: ["amount", "amount (rm)", "deposit amount", "withdrawal amount", "withdraw amount"],
  // The RM figure, next to "Bonus %".
  bonus: ["bonus", "bonus (rm)", "bonus amount"],
};

function findColumns(row: string[]) {
  const cells = row.map(norm);
  const col = (names: string[]) => {
    for (const n of names) {
      const i = cells.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    date: col(HEADERS.date),
    time: col(HEADERS.time),
    code: col(HEADERS.code),
    product: col(HEADERS.product),
    bank: col(HEADERS.bank),
    amount: col(HEADERS.amount),
    bonus: col(HEADERS.bonus),
  };
}

export function parseTab(
  grid: string[][],
  kind: Kind,
  year: number,
  month: number,
  opts: { requireBonus?: boolean } = {},
): SheetRow[] {
  const headerAt = grid.findIndex((r) => {
    const c = findColumns(r);
    return c.date >= 0 && c.code >= 0 && c.amount >= 0;
  });
  if (headerAt < 0) {
    throw new Error(`No header row (Date / Member Code / Amount) on the ${kind} tab`);
  }
  const c = findColumns(grid[headerAt]);
  if (kind === "deposit" && opts.requireBonus && c.bonus < 0) {
    throw new Error(`No "bonus" column on the ${kind} tab`);
  }

  const rows: SheetRow[] = [];
  grid.slice(headerAt + 1).forEach((r, i) => {
    const cell = (j: number) => (j < 0 ? "" : (r[j] ?? "").trim());
    const day = parseSheetDay(cell(c.date), year, month);
    const product = cell(c.product);
    const bank = cell(c.bank);
    const cents = parseCents(cell(c.amount));
    if (!day || cents <= 0) return;
    if (c.product >= 0 && (!product || NON_GAME.has(norm(product)))) return;
    if (kind === "deposit" && c.bank >= 0 && (!bank || PSEUDO_BANKS.has(norm(bank)))) return;
    rows.push({
      kind,
      row: headerAt + 2 + i,
      day,
      time: parseSheetTime(cell(c.time)),
      code: cell(c.code).toUpperCase(),
      cents,
      bonusCents: kind === "withdrawal" ? 0 : c.bonus < 0 ? null : parseCents(cell(c.bonus)),
      bank,
      product,
    });
  });
  return rows;
}

// ── the CRM side ────────────────────────────────────────────────────────────

/** Settled in the CRM — what the sheet's rows should match. */
const DONE = new Set(["completed", "paid"]);

/**
 * One casino's deposits and withdrawals in [from, to), business dates.
 * Failed ones are left out; the rest come back with their status, so a sheet
 * row can be told "it's in the CRM, but stuck at processing".
 */
export async function loadCrmRows(
  db: typeof Db,
  entityId: number,
  from: string,
  to: string,
): Promise<CrmRow[]> {
  const res = await db.execute(sql`
    SELECT 'deposit' AS kind, d.deposit_id AS id,
           upper(trim(p.username)) AS code,
           round(d.deposit_amount * 100)::bigint AS cents,
           round(d.bonus_amount * 100)::bigint AS bonus_cents,
           d.status::text AS status, coalesce(d.bank_name, '') AS bank,
           to_char(d.deposit_date AT TIME ZONE ${BUSINESS_TZ}, 'YYYY-MM-DD') AS day,
           CASE WHEN d.deposit_time_known
                THEN to_char(d.deposit_date AT TIME ZONE ${BUSINESS_TZ}, 'HH24:MI') END AS time
      FROM deposits d JOIN players p ON p.player_id = d.player_id
     WHERE p.company_entity_id = ${entityId}
       AND d.status <> 'failed'
       AND d.deposit_date >= (${from}::date)::timestamp AT TIME ZONE ${BUSINESS_TZ}
       AND d.deposit_date <  (${to}::date)::timestamp AT TIME ZONE ${BUSINESS_TZ}
    UNION ALL
    SELECT 'withdrawal', w.withdrawal_id,
           upper(trim(p.username)),
           round(w.requested_amount * 100)::bigint,
           0::bigint,
           w.status::text, coalesce(w.bank_name, ''),
           to_char(coalesce(w.paid_at, w.created_at) AT TIME ZONE ${BUSINESS_TZ}, 'YYYY-MM-DD'),
           to_char(coalesce(w.paid_at, w.created_at) AT TIME ZONE ${BUSINESS_TZ}, 'HH24:MI')
      FROM withdrawals w JOIN players p ON p.player_id = w.player_id
     WHERE p.company_entity_id = ${entityId}
       AND w.status <> 'failed'
       AND coalesce(w.paid_at, w.created_at) >= (${from}::date)::timestamp AT TIME ZONE ${BUSINESS_TZ}
       AND coalesce(w.paid_at, w.created_at) <  (${to}::date)::timestamp AT TIME ZONE ${BUSINESS_TZ}
  `);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    kind: r.kind as Kind,
    id: Number(r.id),
    code: String(r.code ?? ""),
    cents: Number(r.cents),
    bonusCents: Number(r.bonus_cents),
    status: String(r.status),
    bank: String(r.bank ?? ""),
    day: String(r.day),
    time: r.time == null ? null : String(r.time),
  }));
}

// ── matching ────────────────────────────────────────────────────────────────

/** Minutes since epoch, reading the local wall clock as if it were UTC. */
function minutes(day: string, time: string | null): number {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = (time ?? "12:00").split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) / 60000;
}

/** The bonus was keyed differently. A sheet without a Bonus column never differs. */
const bonusDiffers = (s: SheetRow, c: CrmRow) => s.bonusCents != null && s.bonusCents !== c.bonusCents;

/** Distance between two entries; an unknown time only matches its own day. */
function gap(a: { day: string; time: string | null }, b: { day: string; time: string | null }) {
  if (a.time && b.time) return Math.abs(minutes(a.day, a.time) - minutes(b.day, b.time));
  return a.day === b.day ? 0 : Infinity;
}

/**
 * Pair each sheet row with a CRM row of the same member and amount, closest in
 * time first. Greedy by gap is enough: two same-member same-amount entries an
 * hour apart pair with their own neighbours rather than crossing.
 */
function pairUp(sheet: SheetRow[], crm: CrmRow[]) {
  const byKey = new Map<string, CrmRow[]>();
  for (const c of crm) {
    const k = `${c.kind}|${c.code}|${c.cents}`;
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  const pairs: { g: number; b: number; s: SheetRow; c: CrmRow }[] = [];
  for (const s of sheet) {
    for (const c of byKey.get(`${s.kind}|${s.code}|${s.cents}`) ?? []) {
      const g = gap(s, c);
      if (g <= MATCH_WINDOW_MIN) pairs.push({ g, b: bonusDiffers(s, c) ? 1 : 0, s, c });
    }
  }
  // Two same-member same-amount deposits hours apart are told apart by their
  // bonus before their time: the times are often keyed late, the bonus isn't.
  pairs.sort((a, b) => a.b - b.b || a.g - b.g || a.s.row - b.s.row || a.c.id - b.c.id);
  const usedS = new Set<SheetRow>();
  const usedC = new Set<CrmRow>();
  const matched = new Map<SheetRow, CrmRow>();
  for (const { s, c } of pairs) {
    if (usedS.has(s) || usedC.has(c)) continue;
    usedS.add(s);
    usedC.add(c);
    matched.set(s, c);
  }
  return {
    matched,
    sheetLeft: sheet.filter((s) => !usedS.has(s)),
    crmLeft: crm.filter((c) => !usedC.has(c)),
  };
}

export type Finding =
  | { type: "stuck"; s: SheetRow; c: CrmRow } // in the CRM, never settled
  | { type: "amount"; s: SheetRow; c: CrmRow } // same member, near time, other amount
  | { type: "code"; s: SheetRow; c: CrmRow } // same amount, near time, other member
  | { type: "bonus"; s: SheetRow; c: CrmRow } // matched, but the bonus differs
  | { type: "late"; s: SheetRow; c: CrmRow } // same member and amount, days apart: a late fix
  | { type: "sheet-only"; s: SheetRow }
  | { type: "crm-only"; c: CrmRow };

/**
 * The day a finding is reported under. A late fix (and a bonus difference,
 * which can be one) belongs to the later of its two dates, the day the pair
 * became complete, so it's mentioned the morning after it was keyed in and
 * never before.
 */
export const findingDay = (f: Finding) =>
  f.type === "late" || f.type === "bonus"
    ? f.s.day > f.c.day ? f.s.day : f.c.day
    : "s" in f ? f.s.day : f.c.day;

/** Needs someone to do something. A late fix is already done. */
export const needsAction = (f: Finding) => f.type !== "late";

/**
 * What doesn't agree, for sheet rows and settled CRM rows dated `from` to
 * `through`. Rows either side are loaded only so that an entry near midnight
 * can find its partner; they are never reported. Before `from` is last month,
 * whose sheet is another file this run hasn't fully read; after `through` is a
 * day that isn't over.
 */
export function reconcile(
  sheet: SheetRow[],
  crm: CrmRow[],
  from: string,
  through: string,
): Finding[] {
  const done = crm.filter((c) => DONE.has(c.status));
  const open = crm.filter((c) => !DONE.has(c.status));
  const first = pairUp(sheet, done);
  // A leftover sheet row that matches an unsettled CRM row: the money arrived
  // per the sheet, the CRM entry is still waiting on someone.
  const second = pairUp(first.sheetLeft, open);

  const findings: Finding[] = [];
  for (const [s, c] of second.matched) findings.push({ type: "stuck", s, c });
  // Same deposit on both sides, but the player was credited a different bonus.
  for (const [s, c] of first.matched) {
    if (bonusDiffers(s, c)) findings.push({ type: "bonus", s, c });
  }

  // Near misses, so the report can say "this is probably that" instead of two
  // unrelated-looking lines. One-to-one, tightest first.
  const sheetLeft = new Set(second.sheetLeft);
  const crmLeft = new Set(first.crmLeft);
  const claim = (
    type: "amount" | "code" | "late",
    fits: (s: SheetRow, c: CrmRow) => boolean,
    limit: number,
  ) => {
    const cands: { g: number; s: SheetRow; c: CrmRow }[] = [];
    for (const s of sheetLeft) {
      for (const c of crmLeft) {
        if (s.kind !== c.kind || !fits(s, c)) continue;
        const g = gap(s, c);
        if (g <= limit) cands.push({ g, s, c });
      }
    }
    cands.sort((a, b) => a.g - b.g || a.s.row - b.s.row);
    for (const { s, c } of cands) {
      if (!sheetLeft.has(s) || !crmLeft.has(c)) continue;
      sheetLeft.delete(s);
      crmLeft.delete(c);
      // A late fix keyed with the wrong bonus isn't done yet.
      const wrongBonus = type === "late" && bonusDiffers(s, c);
      findings.push({ type: wrongBonus ? "bonus" : type, s, c });
    }
  };
  claim("amount", (s, c) => s.code === c.code && s.cents !== c.cents, 60);
  claim("code", (s, c) => s.cents === c.cents && s.code !== c.code, 10);
  // A missing row keyed in days later carries the day it was keyed, not the
  // day it happened (the CRM stamps a manual entry with "now"). Same member
  // and amount anywhere in the month is that row, not two separate problems.
  claim("late", (s, c) => s.code === c.code && s.cents === c.cents, Infinity);

  for (const s of sheetLeft) findings.push({ type: "sheet-only", s });
  for (const c of crmLeft) findings.push({ type: "crm-only", c });

  return findings
    .filter((f) => findingDay(f) >= from && findingDay(f) <= through)
    .sort((a, b) => {
      const ka = "s" in a ? `${a.s.day} ${a.s.time ?? ""}` : `${a.c.day} ${a.c.time ?? ""}`;
      const kb = "s" in b ? `${b.s.day} ${b.s.time ?? ""}` : `${b.c.day} ${b.c.time ?? ""}`;
      return ka.localeCompare(kb);
    });
}

// ── the report ──────────────────────────────────────────────────────────────

// Finance reads this on a phone: short lines, items grouped under what's wrong
// so the reason is said once, amounts without "RM" or ".00".

/** 1250 → "1,250"; 2.5 → "2.50". */
const amt = (cents: number) =>
  (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });

const shortDate = (day: string) => {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)}`;
};

const t = (r: { time: string | null }) => (r.time ? ` ${r.time}` : "");
const kindAbbr = (k: Kind) => (k === "deposit" ? "Dep" : "Wd");

const GROUPS: { type: Finding["type"]; title: string }[] = [
  { type: "sheet-only", title: "On sheet, not in CRM" },
  { type: "crm-only", title: "In CRM, not on sheet" },
  { type: "stuck", title: "Not completed in CRM" },
  { type: "amount", title: "Amount differs" },
  { type: "code", title: "Member code differs" },
  { type: "bonus", title: "Bonus differs" },
];

function item(f: Finding): string {
  switch (f.type) {
    case "sheet-only":
      return `${kindAbbr(f.s.kind)} ${f.s.code} ${amt(f.s.cents)}${t(f.s)}`;
    case "crm-only":
      return `${kindAbbr(f.c.kind)} ${f.c.code} ${amt(f.c.cents)}${t(f.c)} #${f.c.id}`;
    case "stuck":
      return `${kindAbbr(f.s.kind)} ${f.s.code} ${amt(f.s.cents)}${t(f.s)} #${f.c.id} ${f.c.status.replace(/_/g, " ")}`;
    case "amount":
      return `${kindAbbr(f.s.kind)} ${f.s.code}${t(f.s)} sheet ${amt(f.s.cents)}, CRM ${amt(f.c.cents)} #${f.c.id}`;
    case "code":
      return `${kindAbbr(f.s.kind)} ${amt(f.s.cents)}${t(f.s)} sheet ${f.s.code}, CRM ${f.c.code} #${f.c.id}`;
    case "bonus":
      return `${kindAbbr(f.s.kind)} ${f.s.code} ${amt(f.s.cents)}${t(f.s)} sheet ${amt(f.s.bonusCents ?? 0)}, CRM ${amt(f.c.bonusCents)} #${f.c.id}`;
    case "late":
      return "";
  }
}

/** Findings under one heading per problem; `dated` prefixes each with its day. */
function grouped(findings: Finding[], dated: boolean): string[] {
  const out: string[] = [];
  for (const { type, title } of GROUPS) {
    const fs = findings.filter((f) => f.type === type);
    if (!fs.length) continue;
    out.push(`${title} (${fs.length})`);
    for (const f of fs) out.push(`• ${dated ? `${shortDate(findingDay(f))} ` : ""}${item(f)}`);
  }
  return out;
}

function dayTotals(rows: { day: string; cents: number; kind: Kind }[], day: string, kind: Kind) {
  const r = rows.filter((x) => x.day === day && x.kind === kind);
  return { n: r.length, cents: r.reduce((a, x) => a + x.cents, 0) };
}

/** Older open items listed individually up to this many; the rest are counted. */
const OLDER_LIST_MAX = 15;

/** "Wed 30 Sep". */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short",
    timeZone: "UTC",
  });
  return `${weekday} ${shortDate(day)}`;
}

export function buildReport(args: {
  company: string;
  day: string;
  sheet: SheetRow[];
  crm: CrmRow[];
  findings: Finding[];
  notes?: string[];
}): string {
  const { company, day, sheet, crm, findings, notes = [] } = args;
  const done = crm.filter((c) => DONE.has(c.status));

  const onDay = findings.filter((f) => findingDay(f) === day);
  const today = onDay.filter(needsAction);
  const late = onDay.filter((f) => !needsAction(f));
  // A late fix is mentioned the once, on its own day; after that it's settled.
  const older = findings.filter((f) => findingDay(f) < day && needsAction(f));

  const status = today.length ? `⚠️ ${today.length} to check` : "✅ all match";
  const lines = [`${company} tally · ${dayLabel(day)} — ${status}`];
  let totalsDiffer = false;
  const total = (label: string, s: { n?: number; cents: number }, c: { n?: number; cents: number }) => {
    const n = (x: { n?: number }) => (x.n == null ? "" : ` (${x.n})`);
    if (s.n === c.n && s.cents === c.cents) {
      lines.push(`${label}: RM ${amt(s.cents)}${n(s)} ✓`);
    } else {
      totalsDiffer = true;
      lines.push(`${label}: sheet RM ${amt(s.cents)}${n(s)} · CRM RM ${amt(c.cents)}${n(c)}`);
    }
  };
  total("Deposits", dayTotals(sheet, day, "deposit"), dayTotals(done, day, "deposit"));
  const bonus = (rows: { day: string; kind: Kind; bonusCents: number | null }[]) => ({
    cents: rows
      .filter((x) => x.day === day && x.kind === "deposit")
      .reduce((a, x) => a + (x.bonusCents ?? 0), 0),
  });
  // Only when the sheet keeps bonuses; otherwise there's nothing to compare.
  if (sheet.some((x) => x.kind === "deposit" && x.bonusCents != null)) {
    total("Bonus", bonus(sheet), bonus(done));
  }
  total("Withdrawals", dayTotals(sheet, day, "withdrawal"), dayTotals(done, day, "withdrawal"));
  if (late.length) {
    lines.push(`${late.length} keyed in late, now matched. No action.`);
  } else if (totalsDiffer && !today.length) {
    lines.push("Totals differ only by entries across midnight.");
  }

  if (today.length) lines.push("", ...grouped(today, false));
  if (older.length) {
    lines.push("", `Still open from earlier: ${older.length}`);
    lines.push(...grouped(older.slice(0, OLDER_LIST_MAX), true));
    if (older.length > OLDER_LIST_MAX) lines.push(`+${older.length - OLDER_LIST_MAX} more`);
  }
  if (notes.length) lines.push("", ...notes);
  return lines.join("\n");
}

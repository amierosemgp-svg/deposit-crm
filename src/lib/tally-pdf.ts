import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { Leader, TallyData, TallyResult } from "@/lib/casino-tally";
import {
  GROUPS,
  bankDiffers,
  dayLabel,
  findingDay,
  isSettled,
  needsAction,
  shortDate,
  type BankLine,
  type DayTotal,
  type Finding,
  type Kind,
} from "@/lib/sheet-tally";

/**
 * The morning tally as one PDF per CRM leader, attached to the email.
 *
 * A leader (Abdullah Club, Bonus Bear…) runs one or more casinos; their PDF
 * has a page section per casino: the email's text as-is, then what the email
 * leaves out — the day's items with bank, product, sheet row and CRM status,
 * every day of the month so far side by side, and everything still open.
 *
 * pdf-lib draws with the PDF's built-in Helvetica: no font files to bundle,
 * which keeps it working on Vercel. That font only covers Windows-1252, so
 * emoji and anything else outside it are swapped out before drawing (safe()).
 */

export type CasinoOutcome = TallyResult & { company: string };

export type LeaderPdf = { leader: Leader; filename: string; content: Uint8Array };

const PAGE: [number, number] = [841.89, 595.28]; // A4 landscape
const M = 36;
const FOOTER = 22;

const INK = rgb(0.12, 0.13, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const ACCENT = rgb(0.11, 0.3, 0.55);
const RULE = rgb(0.82, 0.84, 0.87);
const HEAD_BG = rgb(0.92, 0.93, 0.95);
const ZEBRA = rgb(0.97, 0.975, 0.98);
const OK = rgb(0.1, 0.48, 0.24);
const WARN = rgb(0.72, 0.36, 0.02);
const BAD = rgb(0.72, 0.13, 0.13);

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const at = (r: { day: string; time: string | null }) => `${shortDate(r.day)}${r.time ? ` ${r.time}` : ""}`;

/** Windows-1252's characters above ASCII that sit outside Latin-1. */
const CP1252 = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/** What Helvetica can draw: the email's marks in words, anything else as "?". */
function safe(s: string): string {
  return s
    .replace(/✅\s*/g, "")
    .replace(/⚠️?\s*/g, "")
    .replace(/❌\s*/g, "")
    .replace(/ ✓/g, " (match)")
    .replace(/─/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => (CP1252.includes(ch) ? ch : "?"));
}

type Col = { title: string; width: number; align?: "left" | "right" };
type Cell = string | { text: string; color?: RGB; bold?: boolean };

/** A cursor down the pages: text, headings and tables that break across pages. */
class Writer {
  page!: PDFPage;
  y = 0;
  readonly width = PAGE[0] - 2 * M;

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(PAGE);
    this.y = PAGE[1] - M;
  }

  /** Room for `h` more points on this page, or start the next. */
  need(h: number): boolean {
    if (this.y - h >= M + FOOTER) return false;
    this.newPage();
    return true;
  }

  space(h: number) {
    this.y -= h;
  }

  fit(s: string, w: number, font: PDFFont, size: number): string {
    let t = safe(s);
    if (font.widthOfTextAtSize(t, size) <= w) return t;
    while (t && font.widthOfTextAtSize(`${t}…`, size) > w) t = t.slice(0, -1);
    return `${t}…`;
  }

  text(s: string, o: { size?: number; bold?: boolean; color?: RGB; x?: number; gap?: number } = {}) {
    const size = o.size ?? 9;
    const font = o.bold ? this.bold : this.font;
    this.need(size + (o.gap ?? 4));
    const x = o.x ?? M;
    this.page.drawText(this.fit(s, PAGE[0] - M - x, font, size), {
      x,
      y: this.y - size,
      size,
      font,
      color: o.color ?? INK,
    });
    this.y -= size + (o.gap ?? 4);
  }

  heading(s: string) {
    this.need(48); // never a heading alone at the foot of a page
    this.space(10);
    this.text(s, { size: 11.5, bold: true, color: ACCENT, gap: 6 });
  }

  /** The email's own text, line for line, set off by a bar down the left. */
  quote(lines: string[]) {
    for (const line of lines) {
      if (!line.trim()) {
        this.space(5);
        continue;
      }
      this.need(12);
      this.page.drawRectangle({ x: M, y: this.y - 12, width: 2, height: 12, color: RULE });
      this.text(line, { x: M + 10, size: 9, gap: 3, color: INK });
    }
  }

  table(cols: Col[], rows: Cell[][], o: { size?: number } = {}) {
    const size = o.size ?? 8;
    const rowH = size + 7;
    const scale = this.width / cols.reduce((a, c) => a + c.width, 0);
    const widths = cols.map((c) => c.width * scale);

    const drawRow = (cells: Cell[], fill: RGB | null, header: boolean) => {
      if (fill) {
        this.page.drawRectangle({ x: M, y: this.y - rowH, width: this.width, height: rowH, color: fill });
      }
      let x = M;
      cells.forEach((cell, i) => {
        const c = typeof cell === "string" ? { text: cell } : cell;
        const font = header || c.bold ? this.bold : this.font;
        const w = widths[i] - 6;
        const t = this.fit(c.text, w, font, size);
        const tw = font.widthOfTextAtSize(t, size);
        const tx = cols[i].align === "right" ? x + 3 + w - tw : x + 3;
        this.page.drawText(t, {
          x: tx,
          y: this.y - rowH + 4.5,
          size,
          font,
          color: header ? MUTED : (c.color ?? INK),
        });
        x += widths[i];
      });
      this.y -= rowH;
    };
    const header = () => drawRow(cols.map((c) => c.title), HEAD_BG, true);

    // A short table moves to the next page whole; a long one at least keeps
    // its header with a first row.
    this.need(rowH * (rows.length <= 8 ? rows.length + 1 : 2));
    header();
    rows.forEach((r, i) => {
      if (this.need(rowH)) header();
      drawRow(r, i % 2 ? ZEBRA : null, false);
    });
    this.page.drawLine({
      start: { x: M, y: this.y },
      end: { x: M + this.width, y: this.y },
      thickness: 0.5,
      color: RULE,
    });
    this.space(4);
  }
}

// ── the tables ──────────────────────────────────────────────────────────────

const ITEM_COLS: Col[] = [
  { title: "Problem", width: 104 },
  { title: "Type", width: 30 },
  { title: "Member", width: 82 },
  { title: "Amount RM", width: 64, align: "right" },
  { title: "Bonus RM", width: 64, align: "right" },
  { title: "Sheet date", width: 58 },
  { title: "Row", width: 40, align: "right" },
  { title: "Bank", width: 72 },
  { title: "Product", width: 66 },
  { title: "CRM #", width: 44, align: "right" },
  { title: "CRM date", width: 58 },
  { title: "CRM status", width: 62 },
];

const problemTitle = (f: Finding) =>
  f.type === "late" ? "Keyed in late (no action)" : (GROUPS.find((g) => g.type === f.type)?.title ?? f.type);

const problemColor = (f: Finding) =>
  f.type === "late" ? MUTED : f.type === "sheet-only" || f.type === "crm-only" ? BAD : WARN;

/** "a / b" when the sheet and CRM say different things, else the one value. */
const pair = (a: string | null, b: string | null) =>
  a != null && b != null && a !== b ? `${a} / ${b}` : (a ?? b ?? "");

function itemRow(f: Finding): Cell[] {
  const s = "s" in f ? f.s : null;
  const c = "c" in f ? f.c : null;
  const kind: Kind = (s ?? c)!.kind;
  const bonus =
    kind === "withdrawal"
      ? ""
      : pair(s && s.bonusCents != null ? money(s.bonusCents) : null, c ? money(c.bonusCents) : null);
  return [
    { text: problemTitle(f), color: problemColor(f), bold: f.type !== "late" },
    kind === "deposit" ? "Dep" : "Wd",
    pair(s?.code ?? null, c?.code ?? null),
    pair(s ? money(s.cents) : null, c ? money(c.cents) : null),
    bonus,
    s ? at(s) : "",
    s ? String(s.row) : "",
    s?.bank || c?.bank || "",
    s?.product ?? "",
    c ? String(c.id) : "",
    c ? at(c) : "",
    c ? c.status.replace(/_/g, " ") : "",
  ];
}

/** Grouped like the email (by problem), each group in time order. */
const byProblem = (fs: Finding[]) => {
  const rank = (f: Finding) => {
    const i = GROUPS.findIndex((g) => g.type === f.type);
    return i < 0 ? GROUPS.length : i;
  };
  return [...fs].sort((a, b) => rank(a) - rank(b));
};

type Sums = { n: number; cents: number; bonus: number };

function sums(data: TallyData, day: string, kind: Kind): { sheet: Sums; crm: Sums } {
  const add = (rows: { day: string; kind: Kind; cents: number; bonusCents: number | null }[]) =>
    rows
      .filter((r) => r.day === day && r.kind === kind)
      .reduce((a, r) => ({ n: a.n + 1, cents: a.cents + r.cents, bonus: a.bonus + (r.bonusCents ?? 0) }), {
        n: 0,
        cents: 0,
        bonus: 0,
      });
  return { sheet: add(data.sheet), crm: add(data.crm.filter(isSettled)) };
}

const days = (from: string, through: string) => {
  const out: string[] = [];
  for (let d = from; d <= through; ) {
    out.push(d);
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  }
  return out;
};

/** One day's free credit on each side; the sheet's is null when it has no tab to read. */
function freeCreditOn(data: TallyData, day: string) {
  const on = (rows: DayTotal[]) => rows.find((r) => r.day === day) ?? { day, n: 0, cents: 0 };
  return { sheet: data.freeCredit.sheet ? on(data.freeCredit.sheet) : null, crm: on(data.freeCredit.crm) };
}

function dayTotals(w: Writer, data: TallyData, day: string) {
  const dep = sums(data, day, "deposit");
  const wd = sums(data, day, "withdrawal");
  const fc = freeCreditOn(data, day);
  const hasBonus = data.sheet.some((r) => r.kind === "deposit" && r.bonusCents != null);
  /** A sheet figure of null is one the sheet doesn't keep: the CRM's is shown alone. */
  const line = (label: string, s: number | null, c: number, sn?: number, cn?: number): Cell[] => {
    if (s == null) {
      return [
        { text: label, bold: true },
        "",
        { text: "not on sheet", color: MUTED },
        cn == null ? "" : String(cn),
        money(c),
        "",
        { text: "CRM only", color: MUTED },
      ];
    }
    const same = s === c && sn === cn;
    return [
      { text: label, bold: true },
      sn == null ? "" : String(sn),
      money(s),
      cn == null ? "" : String(cn),
      money(c),
      { text: money(s - c), color: s === c ? MUTED : WARN },
      { text: same ? "Match" : "Differs", color: same ? OK : WARN, bold: true },
    ];
  };
  const rows: Cell[][] = [line("Deposits", dep.sheet.cents, dep.crm.cents, dep.sheet.n, dep.crm.n)];
  rows.push(line("Bonus", hasBonus ? dep.sheet.bonus : null, dep.crm.bonus));
  if (data.withdrawals) rows.push(line("Withdrawals", wd.sheet.cents, wd.crm.cents, wd.sheet.n, wd.crm.n));
  rows.push(line("Free credit", fc.sheet?.cents ?? null, fc.crm.cents, fc.sheet?.n, fc.crm.n));
  w.table(
    [
      { title: "", width: 90 },
      { title: "Sheet entries", width: 70, align: "right" },
      { title: "Sheet RM", width: 90, align: "right" },
      { title: "CRM entries", width: 70, align: "right" },
      { title: "CRM RM", width: 90, align: "right" },
      { title: "Sheet - CRM", width: 90, align: "right" },
      { title: "", width: 70 },
    ],
    rows,
    { size: 9 },
  );
}

function monthToDate(w: Writer, data: TallyData, day: string) {
  const hasBonus = data.sheet.some((r) => r.kind === "deposit" && r.bonusCents != null);
  const open = data.findings.filter(needsAction);
  const cell = (s: number, c: number, sn?: number, cn?: number): [Cell, Cell] => {
    const color = s === c && sn === cn ? INK : WARN;
    const n = (x?: number) => (x == null ? "" : ` (${x})`);
    return [
      { text: `${money(s)}${n(sn)}`, color },
      { text: `${money(c)}${n(cn)}`, color },
    ];
  };
  /** The CRM's figure beside a sheet that doesn't keep it. */
  const crmOnly = (c: number, cn?: number): [Cell, Cell] => [
    { text: "n/a", color: MUTED },
    `${money(c)}${cn == null ? "" : ` (${cn})`}`,
  ];
  const total = { dep: [0, 0, 0, 0], bonus: [0, 0], wd: [0, 0, 0, 0], fc: [0, 0, 0, 0], open: 0 };
  const rows: Cell[][] = days(data.monthStart, day).map((d) => {
    const dep = sums(data, d, "deposit");
    const wd = sums(data, d, "withdrawal");
    const fc = freeCreditOn(data, d);
    const items = open.filter((f) => findingDay(f) === d).length;
    total.dep = [total.dep[0] + dep.sheet.cents, total.dep[1] + dep.crm.cents, total.dep[2] + dep.sheet.n, total.dep[3] + dep.crm.n];
    total.bonus = [total.bonus[0] + dep.sheet.bonus, total.bonus[1] + dep.crm.bonus];
    total.wd = [total.wd[0] + wd.sheet.cents, total.wd[1] + wd.crm.cents, total.wd[2] + wd.sheet.n, total.wd[3] + wd.crm.n];
    total.fc = [total.fc[0] + (fc.sheet?.cents ?? 0), total.fc[1] + fc.crm.cents, total.fc[2] + (fc.sheet?.n ?? 0), total.fc[3] + fc.crm.n];
    total.open += items;
    return [
      dayLabel(d),
      ...cell(dep.sheet.cents, dep.crm.cents, dep.sheet.n, dep.crm.n),
      ...(hasBonus ? cell(dep.sheet.bonus, dep.crm.bonus) : crmOnly(dep.crm.bonus)),
      ...(data.withdrawals ? cell(wd.sheet.cents, wd.crm.cents, wd.sheet.n, wd.crm.n) : ["not checked", "not checked"]),
      ...(fc.sheet ? cell(fc.sheet.cents, fc.crm.cents, fc.sheet.n, fc.crm.n) : crmOnly(fc.crm.cents, fc.crm.n)),
      { text: items ? String(items) : "-", color: items ? WARN : MUTED, bold: items > 0 },
    ];
  });
  const b = (c: Cell): Cell => (typeof c === "string" ? { text: c, bold: true } : { ...c, bold: true });
  rows.push(
    [
      "Month to date",
      ...cell(total.dep[0], total.dep[1], total.dep[2], total.dep[3]),
      ...(hasBonus ? cell(total.bonus[0], total.bonus[1]) : crmOnly(total.bonus[1])),
      ...(data.withdrawals
        ? cell(total.wd[0], total.wd[1], total.wd[2], total.wd[3])
        : ["not checked", "not checked"]),
      ...(data.freeCredit.sheet
        ? cell(total.fc[0], total.fc[1], total.fc[2], total.fc[3])
        : crmOnly(total.fc[1], total.fc[3])),
      { text: total.open ? String(total.open) : "-", color: total.open ? WARN : MUTED },
    ].map(b),
  );
  w.table(
    [
      { title: "Day", width: 58 },
      { title: "Deposits sheet RM (n)", width: 98, align: "right" },
      { title: "Deposits CRM RM (n)", width: 98, align: "right" },
      { title: "Bonus sheet RM", width: 74, align: "right" },
      { title: "Bonus CRM RM", width: 74, align: "right" },
      { title: "Wd sheet RM (n)", width: 90, align: "right" },
      { title: "Wd CRM RM (n)", width: 90, align: "right" },
      { title: "FC sheet RM (n)", width: 84, align: "right" },
      { title: "FC CRM RM (n)", width: 84, align: "right" },
      { title: "Open", width: 34, align: "right" },
    ],
    rows,
  );
  w.text(
    "Wd is withdrawals, FC free credit, Open still open. Amounts in orange differ between the sheet and the CRM. " +
      "A day can differ and still have nothing open: entries either side of midnight, or keyed in late, land on " +
      "different days in each.",
    { size: 7.5, color: MUTED },
  );
}

function bankBalances(w: Writer, banks: BankLine[]) {
  const rows: Cell[][] = banks.map((b) => {
    const off = bankDiffers(b);
    return [
      { text: b.label, bold: true },
      b.account,
      b.sheet == null ? { text: "not on sheet", color: MUTED } : money(b.sheet),
      money(b.crm),
      b.sheet == null ? "" : { text: money(b.sheet - b.crm), color: off ? WARN : MUTED },
      off
        ? { text: "Differs", color: WARN, bold: true }
        : { text: b.sheet == null ? "Empty" : "Match", color: b.sheet == null ? MUTED : OK, bold: true },
    ];
  });
  const sheet = banks.reduce((a, b) => a + (b.sheet ?? 0), 0);
  const crm = banks.reduce((a, b) => a + b.crm, 0);
  rows.push([
    { text: "Total", bold: true },
    "",
    { text: money(sheet), bold: true },
    { text: money(crm), bold: true },
    { text: money(sheet - crm), color: sheet === crm ? MUTED : WARN, bold: true },
    "",
  ]);
  w.table(
    [
      { title: "Account", width: 130 },
      { title: "Bank and number", width: 170 },
      { title: "Sheet RM", width: 90, align: "right" },
      { title: "CRM RM", width: 90, align: "right" },
      { title: "Sheet - CRM", width: 90, align: "right" },
      { title: "", width: 70 },
    ],
    rows,
    { size: 9 },
  );
  w.text(
    "Sheet is the balance beside each bank in the block above the deposit tab's header, which the sheet " +
      "works out from its own rows. An account the sheet doesn't list is shown with the CRM's balance alone.",
    { size: 7.5, color: MUTED },
  );
}

/** Under each item table: how to read a cell holding two values. */
const itemLegend = (w: Writer) =>
  w.text("Where the sheet and the CRM disagree, the cell shows sheet / CRM. Row is the row number on the sheet.", {
    size: 7.5,
    color: MUTED,
  });

function casinoSection(w: Writer, o: CasinoOutcome, day: string, first: boolean) {
  // The first casino follows the cover's summary; the rest start a page each.
  if (first) w.space(18);
  else w.newPage();
  w.text(o.company, { size: 17, bold: true, gap: 6 });
  if (!o.ok) {
    w.text("Couldn't run", { size: 10, bold: true, color: BAD, gap: 10 });
    w.quote(o.text.split("\n"));
    return;
  }
  const status = o.toCheck ? `${o.toCheck} to check on ${dayLabel(day)}` : `All match on ${dayLabel(day)}`;
  const banks = o.banksDiffer ? ` · ${o.banksDiffer} bank balance${o.banksDiffer === 1 ? "" : "s"} differ` : "";
  const open = o.stillOpen ? ` · ${o.stillOpen} still open from earlier this month` : "";
  const flagged = o.toCheck || o.banksDiffer || o.stillOpen;
  w.text(`${status}${banks}${open}`, { size: 10, bold: true, color: flagged ? WARN : OK, gap: 3 });
  w.text(`Sheet: ${o.sheet}`, { size: 8.5, color: MUTED, gap: 4 });

  const { data } = o;
  const onDay = data.findings.filter((f) => findingDay(f) === day);
  const today = byProblem(onDay.filter(needsAction));
  const late = onDay.filter((f) => !needsAction(f));
  const older = byProblem(data.findings.filter((f) => findingDay(f) < day && needsAction(f)));

  w.heading("As in the email");
  w.quote(o.text.split("\n"));

  w.heading(`Day totals · ${dayLabel(day)}`);
  dayTotals(w, data, day);

  if (data.banks) {
    w.heading(`Bank balances · as they stood at ${myt(data.banksAt)} (when this ran)`);
    bankBalances(w, data.banks);
  }

  w.heading(`To check · ${dayLabel(day)} (${today.length})`);
  if (today.length) {
    w.table(ITEM_COLS, today.map(itemRow));
    itemLegend(w);
  } else {
    w.text("Every row matches.", { color: OK });
  }

  if (late.length) {
    w.heading(`Keyed in late, now matched · no action (${late.length})`);
    w.table(ITEM_COLS, late.map(itemRow));
  }

  w.heading(`Month to date · ${shortDate(data.monthStart)} to ${shortDate(day)}`);
  monthToDate(w, data, day);

  w.heading(`Still open from earlier this month (${older.length})`);
  if (older.length) {
    w.table(ITEM_COLS, older.map(itemRow));
    itemLegend(w);
  } else {
    w.text("Nothing.", { color: OK });
  }
  // Notes (withdrawals not checked, last month's sheet missing) are already
  // in the email's text at the top of the section.
}

/** Malaysian wall-clock time, "2 Oct 2026 06:00". */
function myt(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3600_000).toISOString();
  return `${shortDate(d.slice(0, 10))} ${d.slice(0, 4)} ${d.slice(11, 16)}`;
}

const nowMyt = () => myt(new Date().toISOString());

export async function buildLeaderPdf(leader: Leader, day: string, outcomes: CasinoOutcome[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const year = day.slice(0, 4);
  doc.setTitle(`Sheet vs CRM tally · ${leader.name} · ${dayLabel(day)} ${year}`);
  doc.setAuthor("CRM");
  doc.setCreationDate(new Date());
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));

  // Cover: who, which day, and one line per casino.
  w.text("Sheet vs CRM tally", { size: 22, bold: true, gap: 8 });
  w.text(`${leader.name} · ${dayLabel(day)} ${year}`, { size: 13, color: ACCENT, gap: 4 });
  w.text(`Generated ${nowMyt()} (Malaysia time)`, { size: 8.5, color: MUTED, gap: 14 });
  w.table(
    [
      { title: "Casino", width: 120 },
      { title: "Result", width: 110 },
      { title: `To check (${shortDate(day)})`, width: 80, align: "right" },
      { title: "Still open (earlier)", width: 90, align: "right" },
      { title: "Banks differ", width: 70, align: "right" },
      { title: "Sheet", width: 210 },
    ],
    outcomes.map((o): Cell[] =>
      o.ok
        ? [
            { text: o.company, bold: true },
            o.toCheck || o.stillOpen || o.banksDiffer
              ? { text: "Needs checking", color: WARN, bold: true }
              : { text: "All match", color: OK, bold: true },
            String(o.toCheck),
            String(o.stillOpen),
            o.data.banks ? String(o.banksDiffer) : "-",
            o.sheet,
          ]
        : [{ text: o.company, bold: true }, { text: "Couldn't run", color: BAD, bold: true }, "", "", "", ""],
    ),
    { size: 9.5 },
  );
  w.space(6);
  w.text(
    "Each casino follows: the email's text, the day's totals, every item to check with its sheet row and " +
      "CRM entry, the month so far day by day, and anything still open.",
    { size: 8.5, color: MUTED },
  );

  outcomes.forEach((o, i) => casinoSection(w, o, day, i === 0));

  const pages = doc.getPages();
  const footer = safe(`${leader.name} · Sheet vs CRM tally · ${dayLabel(day)} ${year}`);
  pages.forEach((p, i) => {
    const font = w.font;
    p.drawText(footer, { x: M, y: FOOTER, size: 7.5, font, color: MUTED });
    const n = `Page ${i + 1} of ${pages.length}`;
    p.drawText(n, { x: PAGE[0] - M - font.widthOfTextAtSize(n, 7.5), y: FOOTER, size: 7.5, font, color: MUTED });
  });
  return doc.save();
}

/**
 * One PDF per leader, for the casinos that ran (or failed) with a known
 * leader. A casino whose CRM company couldn't be found has no leader and is
 * only in the email.
 */
export async function buildLeaderPdfs(day: string, outcomes: CasinoOutcome[]): Promise<LeaderPdf[]> {
  const groups = new Map<number, { leader: Leader; outcomes: CasinoOutcome[] }>();
  for (const o of outcomes) {
    const leader = o.leader;
    if (!leader) continue;
    const g = groups.get(leader.id) ?? { leader, outcomes: [] };
    g.outcomes.push(o);
    groups.set(leader.id, g);
  }
  const sorted = [...groups.values()].sort((a, b) => a.leader.name.localeCompare(b.leader.name));
  return Promise.all(
    sorted.map(async ({ leader, outcomes: os }) => ({
      leader,
      filename: `Tally ${day} - ${leader.name.replace(/[^A-Za-z0-9 ._-]+/g, "").trim() || `Leader ${leader.id}`}.pdf`,
      content: await buildLeaderPdf(leader, day, os),
    })),
  );
}

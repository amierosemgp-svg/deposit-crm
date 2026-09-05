/**
 * Date-range filtering for the worksheets: an inclusive from/to pair of
 * calendar days, plus the quick presets the toolbar offers. Days are read in
 * the browser's local zone, which for this business is Malaysia time — the
 * same zone the sheets print dates in.
 */

/** Inclusive calendar-day bounds, "YYYY-MM-DD"; null = open-ended. */
export type DateRange = { from: string | null; to: string | null };

export type RangePreset =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_7"
  | "this_month"
  | "last_month"
  | "all";

export const RANGE_PRESETS: Array<{ key: RangePreset; label: string }> = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This week" },
  { key: "last_7", label: "Last 7 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "all", label: "All time" },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** A Date's calendar day in local time, "YYYY-MM-DD". */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The calendar day an ISO instant falls on, in local time. */
export function localYmd(iso: string): string {
  return ymd(new Date(iso));
}

export function presetRange(preset: RangePreset, now = new Date()): DateRange {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (d: Date, days: number) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  switch (preset) {
    case "today":
      return { from: ymd(today), to: ymd(today) };
    case "yesterday": {
      const y = shift(today, -1);
      return { from: ymd(y), to: ymd(y) };
    }
    case "this_week": {
      // Weeks start Monday, as the rebate cutoffs and the workbook do.
      const back = (today.getDay() + 6) % 7;
      return { from: ymd(shift(today, -back)), to: ymd(today) };
    }
    case "last_7":
      return { from: ymd(shift(today, -6)), to: ymd(today) };
    case "this_month":
      return {
        from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)),
        to: ymd(today),
      };
    case "last_month": {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: ymd(first), to: ymd(last) };
    }
    case "all":
      return { from: null, to: null };
  }
}

/** Whether an ISO instant's local day falls inside the range (inclusive). */
export function inRange(iso: string, r: DateRange): boolean {
  if (!r.from && !r.to) return true;
  const day = localYmd(iso);
  if (r.from && day < r.from) return false;
  if (r.to && day > r.to) return false;
  return true;
}

/** "5 Sep 2026", "1–5 Sep 2026", "28 Aug – 5 Sep 2026", "All time". */
export function rangeLabel(r: DateRange): string {
  if (!r.from && !r.to) return "All time";
  const fmt = (s: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", opts);
  const full: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  if (!r.from) return `Up to ${fmt(r.to!, full)}`;
  if (!r.to) return `From ${fmt(r.from, full)}`;
  if (r.from === r.to) return fmt(r.from, full);
  const sameMonth = r.from.slice(0, 7) === r.to.slice(0, 7);
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  if (sameMonth) return `${fmt(r.from, { day: "numeric" })}–${fmt(r.to, full)}`;
  if (sameYear) return `${fmt(r.from, { day: "numeric", month: "short" })} – ${fmt(r.to, full)}`;
  return `${fmt(r.from, full)} – ${fmt(r.to, full)}`;
}

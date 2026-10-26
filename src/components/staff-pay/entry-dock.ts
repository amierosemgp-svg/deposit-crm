"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { DraftStatus } from "@/components/sheet/sheet-grid";

/**
 * The NEW ENTRIES dock for the staff-pay sheets — the same model as the
 * Transactions tabs: typed rows below the saved ones, cells the CRM works out
 * filled in as you go, ⌘S (or Save) commits every ✓ row, a refused row stays
 * put marked ! with the server's reason.
 */

const MIN_ROWS = 6;
const TRAILING_BLANKS = 3;
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export type Parsed<B> = { ok: true; body: B } | { ok: false; error: string };

export function useEntryDock<B>({
  nCols,
  autoCells,
  derive,
  parse,
  submit,
  noun,
  onSaved,
  enabled,
}: {
  nCols: number;
  /** Cells a fresh row starts with — they don't make a row "typed". */
  autoCells: () => Array<[number, string]>;
  /** Fill the derived cells of every row from the typed ones. */
  derive: (rows: string[][]) => string[][];
  /** null = still working something out (a lookup in flight); not an error. */
  parse: (row: string[]) => Parsed<B> | null;
  submit: (body: B) => Promise<{ ok: true } | { ok: false; error: string }>;
  noun: (n: number) => string;
  onSaved: () => void | Promise<void>;
  enabled: boolean;
}) {
  const blank = useCallback(() => {
    const row = Array<string>(nCols).fill("");
    for (const [i, v] of autoCells()) row[i] = v;
    return row;
  }, [nCols, autoCells]);

  const isBlank = useCallback(
    (row: string[]) => {
      const auto = new Map(autoCells());
      return row.every((v, i) => !v.trim() || auto.get(i) === v);
    },
    [autoCells],
  );

  const pad = useCallback(
    (rows: string[][]) => {
      const next = rows.filter((r) => r.length === nCols);
      let trailing = 0;
      for (let i = next.length - 1; i >= 0 && isBlank(next[i]); i--) trailing++;
      const want = Math.max(MIN_ROWS - next.length, TRAILING_BLANKS - trailing);
      for (let i = 0; i < want; i++) next.push(blank());
      return next;
    },
    [nCols, isBlank, blank],
  );

  const [raw, setRaw] = useState<string[][]>(() => []);
  const drafts = useMemo(() => pad(derive(raw)), [raw, derive, pad]);
  const onDraftsChange = useCallback((next: string[][]) => setRaw(next), []);

  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const keyOf = (row: string[]) => row.join("\u0001");

  const draftStatus = useCallback(
    (row: string[]): DraftStatus => {
      if (isBlank(row)) return { state: "empty" };
      const refused = errors.get(keyOf(row));
      if (refused) return { state: "error", message: refused };
      const p = parse(row);
      if (!p) return { state: "empty" };
      return p.ok ? { state: "ready" } : { state: "error", message: p.error };
    },
    [isBlank, errors, parse],
  );

  const readyCount = useMemo(
    () => drafts.filter((d) => draftStatus(d).state === "ready").length,
    [drafts, draftStatus],
  );

  const flushRef = useRef<null | (() => { draftIndex: number; col: number; value: string } | null)>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const commit = useCallback(async () => {
    if (savingRef.current || !enabled) return;
    savingRef.current = true;
    setSaving(true);
    try {
      // Land the cell still being typed — ⌘S is caught before the editor sees it.
      const pending = flushRef.current?.() ?? null;
      const rows = derive(
        pending
          ? drafts.map((d, i) => (i === pending.draftIndex ? d.map((v, c) => (c === pending.col ? pending.value : v)) : d))
          : drafts,
      );
      const jobs = rows
        .map((row, i) => ({ row, i, p: isBlank(row) ? null : parse(row) }))
        .filter((j): j is { row: string[]; i: number; p: { ok: true; body: B } } => !!j.p?.ok);
      if (!jobs.length) {
        toast.info("Nothing ready to save — fill a row until it shows ✓");
        return;
      }
      const done = new Set<number>();
      const failed = new Map<string, string>();
      // One at a time: two salaries from the same account must see each
      // other's debit, and the order on screen is the order they land.
      for (const j of jobs) {
        const res = await submit(j.p.body);
        if (res.ok) done.add(j.i);
        else failed.set(keyOf(j.row), res.error);
      }
      setRaw(rows.filter((_, i) => !done.has(i)));
      setErrors(failed);
      if (failed.size) {
        toast.error(`${done.size} saved, ${failed.size} refused`, {
          description: [...new Set(failed.values())].slice(0, 3).join("\n"),
          duration: 15_000,
        });
      } else {
        toast.success(`${done.size} ${noun(done.size)} saved`);
      }
      if (done.size) await onSaved();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [enabled, drafts, derive, isBlank, parse, submit, noun, onSaved]);

  // ⌘S / Ctrl+S, like every other sheet.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const wrongMod = IS_MAC ? e.ctrlKey : e.metaKey;
      if (!mod || wrongMod || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      void commit();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, commit]);

  /** Write cells into one row from outside — a lookup that came back. */
  const patchRow = useCallback(
    (match: (row: string[]) => boolean, patch: (row: string[]) => string[]) =>
      setRaw((prev) => {
        const base = pad(derive(prev));
        let changed = false;
        const next = base.map((r) => {
          if (!match(r)) return r;
          const p = patch(r);
          if (p.some((v, i) => v !== r[i])) changed = true;
          return p;
        });
        return changed ? next : prev;
      }),
    [pad, derive],
  );

  return { drafts, onDraftsChange, draftStatus, readyCount, flushRef, saving, commit, patchRow };
}

// ---------- cell parsing, the workbook's way ----------

export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]|RM/gi, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "31/8/2026" or "2026-08-31" → "2026-08-31". */
export function parseSheetDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${yyyy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "2026-09", "9/2026", "Sep 2026", "September 2026" → "2026-09". */
export function parseMonth(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return valid(Number(m[1]), Number(m[2]));
  m = s.match(/^(\d{1,2})[/.-](\d{4})$/);
  if (m) return valid(Number(m[2]), Number(m[1]));
  m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/);
  if (m) return valid(Number(m[2]), MONTHS.indexOf(m[1]) + 1);
  return null;
}

function valid(y: number, m: number): string | null {
  return m >= 1 && m <= 12 ? `${y}-${String(m).padStart(2, "0")}` : null;
}

/** Today, the workbook's way — "19/10/2026". */
export function todaySheetDate(): string {
  const d = new Date(Date.now() + 8 * 3600_000);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
}

export const fmtAmount = (n: number) =>
  n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

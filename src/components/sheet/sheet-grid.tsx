"use client";

/**
 * SheetGrid — an Excel-style grid for people migrating off a real workbook.
 *
 * Two regions in one grid: committed rows on top (read-only — they are server
 * records) and draft "entry rows" underneath, where new transactions are typed
 * or pasted exactly the way they were in the sheet. The keyboard model is
 * Excel's, because that is the muscle memory being migrated:
 *
 *   arrows / Tab / Enter    move the selected cell (Shift reverses)
 *   Shift+arrows            grow the selection
 *   type / F2 / double-click edit a draft cell (typing replaces, F2 appends)
 *   Esc                     cancel the edit
 *   Ctrl/Cmd+C / V          copy any range · paste a TSV block into the drafts
 *   Delete / Backspace      clear the selected draft cells
 *   Ctrl/Cmd+Enter          commit the ready entry rows (parent handles it)
 *
 * Copy/paste rides the native clipboard events on the focused wrapper — no
 * navigator.clipboard permission prompt, and Excel's own TSV format both ways.
 */

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

export type SheetColumn = {
  key: string;
  label: string;
  /** Column width in px (the table is fixed-layout, like a spreadsheet). */
  width: number;
  align?: "left" | "right" | "center";
  /**
   * Saved when the entry row commits. Columns without it stay typable — a
   * pasted sheet row keeps its shape — but render dimmed to say "the CRM
   * derives this one itself".
   */
  entry?: boolean;
  required?: boolean;
  numeric?: boolean;
  /** Autocomplete suggestions offered while editing (datalist). */
  options?: string[];
};

export type SheetRowTone = "default" | "success" | "danger" | "warning" | "muted";

export type SheetRow = {
  id: string | number;
  cells: string[];
  tone?: SheetRowTone;
};

export type DraftStatus =
  | { state: "empty" }
  | { state: "ready" }
  | { state: "error"; message: string };

type CellPos = { r: number; c: number };

type Editing = CellPos & {
  value: string;
  /** Started by typing — arrows commit-and-move instead of moving the caret. */
  replace: boolean;
};

function colLetter(index: number): string {
  let s = "";
  let i = index + 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function parseNumeric(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]|RM/gi, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const TONE_TEXT: Record<SheetRowTone, string> = {
  default: "",
  success: "text-emerald-700 dark:text-emerald-400",
  danger: "text-red-600 dark:text-red-400",
  warning: "text-amber-700 dark:text-amber-400",
  muted: "text-muted-foreground",
};

/** Selection slice handed to a row — computed narrow so memo() can bite. */
type RowSel = { c1: number; c2: number; anchorC: number } | null;

const GridRow = memo(function GridRow({
  rIdx,
  gutter,
  gutterTitle,
  marker,
  cells,
  columns,
  tone,
  isDraft,
  firstDraft,
  sel,
  editing,
  editorProps,
  onCellMouseDown,
  onCellMouseEnter,
  onCellDoubleClick,
}: {
  rIdx: number;
  gutter: string;
  gutterTitle?: string;
  marker: "ready" | "error" | null;
  cells: string[];
  columns: SheetColumn[];
  tone: SheetRowTone;
  isDraft: boolean;
  firstDraft: boolean;
  sel: RowSel;
  /** Column being edited in this row, or -1. */
  editing: number;
  editorProps: EditorProps | null;
  onCellMouseDown: (r: number, c: number, shift: boolean) => void;
  onCellMouseEnter: (r: number, c: number) => void;
  onCellDoubleClick: (r: number, c: number) => void;
}) {
  return (
    <tr
      className={cn(
        "h-7",
        firstDraft && "border-t-2 border-t-emerald-600 dark:border-t-emerald-500",
      )}
    >
      <td
        title={gutterTitle}
        className={cn(
          "sticky left-0 z-10 select-none border-b border-r border-border bg-muted px-1 text-center text-[11px] tabular-nums text-muted-foreground",
          marker === "ready" && "text-emerald-600",
          marker === "error" && "bg-red-100 font-semibold text-red-600 dark:bg-red-950",
        )}
      >
        {marker === "ready" ? "✓" : marker === "error" ? "!" : gutter}
      </td>
      {columns.map((col, c) => {
        const selected = sel !== null && c >= sel.c1 && c <= sel.c2;
        const isAnchor = sel !== null && c === sel.anchorC;
        const isEditing = editing === c;
        return (
          <td
            key={col.key}
            data-cell={`${rIdx}-${c}`}
            onMouseDown={(e) => {
              // Left button only; shift-click extends like Excel.
              if (e.button === 0) onCellMouseDown(rIdx, c, e.shiftKey);
            }}
            onMouseEnter={() => onCellMouseEnter(rIdx, c)}
            onDoubleClick={() => onCellDoubleClick(rIdx, c)}
            className={cn(
              "relative cursor-cell select-none overflow-hidden whitespace-nowrap border-b border-r border-border px-1.5 text-[13px]",
              col.align === "right" && "text-right tabular-nums",
              col.align === "center" && "text-center",
              tone !== "default" && TONE_TEXT[tone],
              isDraft && !col.entry && "italic text-muted-foreground",
              selected && "bg-emerald-600/10 dark:bg-emerald-400/10",
              isAnchor &&
                "outline outline-2 -outline-offset-1 outline-emerald-600 dark:outline-emerald-400",
            )}
          >
            {isEditing && editorProps ? <CellEditor {...editorProps} /> : cells[c] ?? ""}
          </td>
        );
      })}
      {/* Filler — absorbs the leftover width so the gridlines run the full
          row, like the empty columns beyond the data in a real sheet. */}
      <td className="border-b border-border" />
    </tr>
  );
});

type EditorProps = {
  value: string;
  listId?: string;
  align?: "left" | "right" | "center";
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
};

function CellEditor({ value, listId, align, onChange, onKeyDown, onBlur }: EditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    // Caret at the end, matching Excel's edit-in-place feel.
    ref.current?.setSelectionRange(value.length, value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      ref={ref}
      list={listId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className={cn(
        "absolute inset-0 z-10 w-full border-2 border-emerald-600 bg-background px-1 text-[13px] outline-none dark:border-emerald-400",
        align === "right" && "text-right",
        align === "center" && "text-center",
      )}
    />
  );
}

export function SheetGrid({
  columns,
  rows,
  drafts,
  onDraftsChange,
  draftStatus,
  onCommit,
  readOnly = false,
  /** Changing this key re-scrolls to the entry area and selects its first cell. */
  focusKey,
}: {
  columns: SheetColumn[];
  rows: SheetRow[];
  drafts: string[][];
  onDraftsChange: (next: string[][]) => void;
  draftStatus: (draft: string[], index: number) => DraftStatus;
  onCommit: () => void;
  readOnly?: boolean;
  focusKey?: string;
}) {
  const gridId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<CellPos | null>(null);
  const [ext, setExt] = useState<CellPos | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const draggingRef = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nRows = rows.length + drafts.length;
  const nCols = columns.length;
  const draftStart = rows.length;

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

  const cellValue = useCallback(
    (r: number, c: number): string =>
      r < rows.length ? (rows[r].cells[c] ?? "") : (drafts[r - rows.length]?.[c] ?? ""),
    [rows, drafts],
  );

  const bounds = useMemo(() => {
    if (!sel) return null;
    const e = ext ?? sel;
    return {
      r1: Math.min(sel.r, e.r),
      r2: Math.max(sel.r, e.r),
      c1: Math.min(sel.c, e.c),
      c2: Math.max(sel.c, e.c),
    };
  }, [sel, ext]);

  const scrollCellIntoView = useCallback((r: number, c: number) => {
    const el = containerRef.current?.querySelector(`[data-cell="${r}-${c}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  const moveTo = useCallback(
    (r: number, c: number, extend = false) => {
      const nr = Math.max(0, Math.min(nRows - 1, r));
      const nc = Math.max(0, Math.min(nCols - 1, c));
      if (extend) {
        setExt({ r: nr, c: nc });
      } else {
        setSel({ r: nr, c: nc });
        setExt(null);
      }
      scrollCellIntoView(nr, nc);
    },
    [nRows, nCols, scrollCellIntoView],
  );

  // ---- draft mutation helpers ----

  const setDraftCell = useCallback(
    (r: number, c: number, value: string) => {
      const i = r - draftStart;
      if (i < 0) return;
      const next = drafts.map((row) => [...row]);
      while (next.length <= i) next.push(Array(nCols).fill(""));
      next[i][c] = value;
      onDraftsChange(next);
    },
    [drafts, draftStart, nCols, onDraftsChange],
  );

  const clearDraftRange = useCallback(() => {
    if (!bounds) return;
    const next = drafts.map((row) => [...row]);
    let touched = false;
    for (let r = Math.max(bounds.r1, draftStart); r <= bounds.r2; r++) {
      const i = r - draftStart;
      if (!next[i]) continue;
      for (let c = bounds.c1; c <= bounds.c2; c++) {
        if (next[i][c]) {
          next[i][c] = "";
          touched = true;
        }
      }
    }
    if (touched) onDraftsChange(next);
  }, [bounds, drafts, draftStart, onDraftsChange]);

  // ---- editing ----

  const startEdit = useCallback(
    (r: number, c: number, seed?: string) => {
      if (readOnly) return;
      if (r < draftStart) {
        flash("Saved rows are read-only — new entries go in the rows below the green line.");
        return;
      }
      setEditing({
        r,
        c,
        value: seed !== undefined ? seed : cellValue(r, c),
        replace: seed !== undefined,
      });
    },
    [readOnly, draftStart, cellValue, flash],
  );

  const commitEdit = useCallback(
    (move: "down" | "right" | "left" | "up" | "none") => {
      if (!editing) return;
      setDraftCell(editing.r, editing.c, editing.value);
      setEditing(null);
      // Refocus the wrapper so the next keystroke keeps navigating.
      containerRef.current?.focus();
      if (move === "down") moveTo(editing.r + 1, editing.c);
      else if (move === "up") moveTo(editing.r - 1, editing.c);
      else if (move === "right") moveTo(editing.r, editing.c + 1);
      else if (move === "left") moveTo(editing.r, editing.c - 1);
    },
    [editing, setDraftCell, moveTo],
  );

  const cancelEdit = useCallback(() => {
    setEditing(null);
    containerRef.current?.focus();
  }, []);

  // ---- clipboard ----

  const handleCopy = useCallback(
    (e: React.ClipboardEvent) => {
      if (editing || !bounds) return;
      const lines: string[] = [];
      for (let r = bounds.r1; r <= bounds.r2; r++) {
        const cells: string[] = [];
        for (let c = bounds.c1; c <= bounds.c2; c++) cells.push(cellValue(r, c));
        lines.push(cells.join("\t"));
      }
      e.clipboardData.setData("text/plain", lines.join("\n"));
      e.preventDefault();
    },
    [editing, bounds, cellValue],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (editing || readOnly) return;
      const text = e.clipboardData.getData("text/plain");
      if (!text || !sel) return;
      e.preventDefault();
      if (sel.r < draftStart) {
        flash("Paste into the entry rows below the green line — saved rows can't be overwritten.");
        return;
      }
      const lines = text.replace(/\r/g, "").split("\n");
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (!lines.length) return;

      const startI = sel.r - draftStart;
      const next = drafts.map((row) => [...row]);
      while (next.length < startI + lines.length) next.push(Array(nCols).fill(""));
      let maxC = sel.c;
      lines.forEach((line, dr) => {
        line.split("\t").forEach((val, dc) => {
          const c = sel.c + dc;
          if (c >= nCols) return;
          next[startI + dr][c] = val.trim();
          if (c > maxC) maxC = c;
        });
      });
      onDraftsChange(next);
      setExt({ r: sel.r + lines.length - 1, c: maxC });
    },
    [editing, readOnly, sel, draftStart, drafts, nCols, onDraftsChange, flash],
  );

  // ---- keyboard ----

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return; // the editor input owns the keyboard
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key === "Enter") {
        e.preventDefault();
        onCommit();
        return;
      }
      if (mod && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        if (nRows) {
          setSel({ r: 0, c: 0 });
          setExt({ r: nRows - 1, c: nCols - 1 });
        }
        return;
      }
      // Copy/paste arrive via the clipboard events; don't swallow them here.
      if (mod) return;

      if (!sel) {
        if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab", "Enter"].includes(e.key)) {
          e.preventDefault();
          moveTo(draftStart, 0);
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (e.shiftKey) moveTo((ext ?? sel).r + 1, (ext ?? sel).c, true);
          else moveTo(sel.r + 1, sel.c);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (e.shiftKey) moveTo((ext ?? sel).r - 1, (ext ?? sel).c, true);
          else moveTo(sel.r - 1, sel.c);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) moveTo((ext ?? sel).r, (ext ?? sel).c + 1, true);
          else moveTo(sel.r, sel.c + 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) moveTo((ext ?? sel).r, (ext ?? sel).c - 1, true);
          else moveTo(sel.r, sel.c - 1);
          break;
        case "Tab":
          e.preventDefault();
          moveTo(sel.r, sel.c + (e.shiftKey ? -1 : 1));
          break;
        case "Enter":
          e.preventDefault();
          moveTo(sel.r + (e.shiftKey ? -1 : 1), sel.c);
          break;
        case "Home":
          e.preventDefault();
          moveTo(sel.r, 0);
          break;
        case "End":
          e.preventDefault();
          moveTo(sel.r, nCols - 1);
          break;
        case "PageDown":
          e.preventDefault();
          moveTo(sel.r + 20, sel.c);
          break;
        case "PageUp":
          e.preventDefault();
          moveTo(sel.r - 20, sel.c);
          break;
        case "F2":
          e.preventDefault();
          startEdit(sel.r, sel.c);
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          if (readOnly) break;
          if (sel.r < draftStart && (!bounds || bounds.r2 < draftStart)) {
            flash("Saved rows are read-only.");
          } else {
            clearDraftRange();
          }
          break;
        case "Escape":
          setExt(null);
          break;
        default:
          // Type-to-edit, Excel's "enter mode": the keystroke replaces the cell.
          if (e.key.length === 1 && !e.altKey) {
            e.preventDefault();
            startEdit(sel.r, sel.c, e.key);
          }
      }
    },
    [
      editing, sel, ext, bounds, nRows, nCols, draftStart, readOnly,
      moveTo, startEdit, clearDraftRange, onCommit, flash,
    ],
  );

  // ---- mouse ----

  const onCellMouseDown = useCallback(
    (r: number, c: number, shift: boolean) => {
      if (editing) commitEdit("none");
      draggingRef.current = true;
      if (shift && sel) setExt({ r, c });
      else {
        setSel({ r, c });
        setExt(null);
      }
    },
    [editing, commitEdit, sel],
  );

  const onCellMouseEnter = useCallback((r: number, c: number) => {
    if (draggingRef.current) setExt({ r, c });
  }, []);

  useEffect(() => {
    const up = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const onCellDoubleClick = useCallback(
    (r: number, c: number) => startEdit(r, c),
    [startEdit],
  );

  // Tab switch: jump to the entry area, ready to type.
  useEffect(() => {
    if (focusKey === undefined) return;
    const t = setTimeout(() => {
      const firstEmpty = drafts.findIndex((d) => d.every((v) => !v));
      const r = draftStart + (firstEmpty === -1 ? 0 : firstEmpty);
      const c = columns.findIndex((col) => col.entry);
      moveTo(r, Math.max(0, c));
      containerRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
    // Only when the tab (focusKey) changes — not on every data poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // ---- selection stats (the Excel status bar) ----

  const stats = useMemo(() => {
    if (!bounds) return null;
    let count = 0;
    let numCount = 0;
    let sum = 0;
    for (let r = bounds.r1; r <= bounds.r2; r++) {
      for (let c = bounds.c1; c <= bounds.c2; c++) {
        const v = cellValue(r, c);
        if (!v) continue;
        count++;
        const n = columns[c]?.numeric ? parseNumeric(v) : null;
        if (n !== null) {
          numCount++;
          sum += n;
        }
      }
    }
    return { count, numCount, sum, avg: numCount ? sum / numCount : 0 };
  }, [bounds, cellValue, columns]);

  const address = useMemo(() => {
    if (!sel) return "";
    const a = `${colLetter(sel.c)}${sel.r + 1}`;
    if (!ext || (ext.r === sel.r && ext.c === sel.c)) return a;
    return `${a}:${colLetter(ext.c)}${ext.r + 1}`;
  }, [sel, ext]);

  const editorProps: EditorProps | null = editing
    ? {
        value: editing.value,
        align: columns[editing.c]?.align,
        listId: columns[editing.c]?.options ? `${gridId}-dl-${editing.c}` : undefined,
        onChange: (v) => setEditing((prev) => (prev ? { ...prev, value: v } : prev)),
        onKeyDown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitEdit(e.shiftKey ? "up" : "down");
          } else if (e.key === "Tab") {
            e.preventDefault();
            commitEdit(e.shiftKey ? "left" : "right");
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelEdit();
          } else if (editing.replace && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            commitEdit(e.key === "ArrowDown" ? "down" : "up");
          } else if (
            editing.replace &&
            (e.key === "ArrowRight" || e.key === "ArrowLeft")
          ) {
            e.preventDefault();
            commitEdit(e.key === "ArrowRight" ? "right" : "left");
          }
        },
        onBlur: () => commitEdit("none"),
      }
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onCopy={handleCopy}
        onCut={(e) => {
          handleCopy(e);
          if (!readOnly) clearDraftRange();
        }}
        onPaste={handlePaste}
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        <table className="w-full table-fixed border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: 44 }} />
            {columns.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
            {/* Unsized filler column — takes whatever width is left. */}
            <col />
          </colgroup>
          <thead>
            {/* Column letters — pure Excel chrome, and the anchor for "paste
                starting at column A" instructions between colleagues. */}
            <tr className="h-5">
              <th className="sticky left-0 top-0 z-30 border-b border-r border-border bg-muted" />
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  className="sticky top-0 z-20 select-none border-b border-r border-border bg-muted text-center text-[10px] font-normal text-muted-foreground"
                >
                  {colLetter(i)}
                </th>
              ))}
              <th className="sticky top-0 z-20 border-b border-border bg-muted" />
            </tr>
            <tr className="h-7">
              <th className="sticky left-0 top-5 z-30 border-b border-r border-border bg-emerald-700 dark:bg-emerald-800" />
              {columns.map((c) => (
                <th
                  key={c.key}
                  title={c.entry ? undefined : "Filled in by the CRM — not saved from entry rows"}
                  className={cn(
                    "sticky top-5 z-20 select-none overflow-hidden whitespace-nowrap border-b border-r border-emerald-800 bg-emerald-700 px-1.5 text-left text-[12px] font-semibold text-white dark:border-emerald-700 dark:bg-emerald-800",
                    c.align === "right" && "text-right",
                    c.align === "center" && "text-center",
                    !c.entry && "font-normal text-emerald-100/80",
                  )}
                >
                  {c.label}
                  {c.required ? " *" : ""}
                </th>
              ))}
              {/* Filler keeps the green header band running edge to edge. */}
              <th className="sticky top-5 z-20 border-b border-emerald-800 bg-emerald-700 dark:border-emerald-700 dark:bg-emerald-800" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <GridRow
                key={row.id}
                rIdx={r}
                gutter={String(r + 1)}
                marker={null}
                cells={row.cells}
                columns={columns}
                tone={row.tone ?? "default"}
                isDraft={false}
                firstDraft={false}
                sel={
                  bounds && r >= bounds.r1 && r <= bounds.r2
                    ? {
                        c1: bounds.c1,
                        c2: bounds.c2,
                        anchorC: sel && sel.r === r ? sel.c : -1,
                      }
                    : null
                }
                editing={-1}
                editorProps={null}
                onCellMouseDown={onCellMouseDown}
                onCellMouseEnter={onCellMouseEnter}
                onCellDoubleClick={onCellDoubleClick}
              />
            ))}
            {!readOnly &&
              drafts.map((draft, i) => {
                const r = draftStart + i;
                const status = draftStatus(draft, i);
                return (
                  <GridRow
                    key={`draft-${i}`}
                    rIdx={r}
                    gutter={String(r + 1)}
                    gutterTitle={status.state === "error" ? status.message : undefined}
                    marker={
                      status.state === "ready"
                        ? "ready"
                        : status.state === "error"
                          ? "error"
                          : null
                    }
                    cells={draft}
                    columns={columns}
                    tone="default"
                    isDraft
                    firstDraft={i === 0}
                    sel={
                      bounds && r >= bounds.r1 && r <= bounds.r2
                        ? {
                            c1: bounds.c1,
                            c2: bounds.c2,
                            anchorC: sel && sel.r === r ? sel.c : -1,
                          }
                        : null
                    }
                    editing={editing && editing.r === r ? editing.c : -1}
                    editorProps={editing && editing.r === r ? editorProps : null}
                    onCellMouseDown={onCellMouseDown}
                    onCellMouseEnter={onCellMouseEnter}
                    onCellDoubleClick={onCellDoubleClick}
                  />
                );
              })}
          </tbody>
        </table>
        {/* Datalists for entry columns with suggestions. */}
        {columns.map((c, i) =>
          c.options ? (
            <datalist key={c.key} id={`${gridId}-dl-${i}`}>
              {c.options.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          ) : null,
        )}
      </div>

      {/* Status bar — address on the left, Sum/Avg/Count on the right, exactly
          where a spreadsheet person's eyes go after selecting a column. */}
      <div className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-muted px-3 text-[11px] text-muted-foreground">
        <span className="w-24 shrink-0 font-medium tabular-nums">{address}</span>
        <span className="min-w-0 flex-1 truncate">
          {notice ? (
            <span className="text-amber-700 dark:text-amber-400">{notice}</span>
          ) : readOnly ? (
            "Read-only view"
          ) : (
            "Type into the rows below the green line · Enter/Tab/arrows to move · paste straight from Excel · Ctrl+Enter saves ready rows"
          )}
        </span>
        {stats && stats.count > 0 && (
          <span className="shrink-0 tabular-nums">
            {stats.numCount > 0 && (
              <>
                Sum:{" "}
                <span className="font-semibold text-foreground">
                  {stats.sum.toLocaleString("en-MY", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                {"  ·  Avg: "}
                {stats.avg.toLocaleString("en-MY", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
                {"  ·  "}
              </>
            )}
            Count: {stats.count}
          </span>
        )}
      </div>
    </div>
  );
}

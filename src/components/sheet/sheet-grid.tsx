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
 *   Ctrl/Cmd+↑ / ↓          jump to the top / bottom of the block you are in
 *   Ctrl/Cmd+click          add another rectangle to the selection
 *   type / F2 / double-click edit a draft cell (typing replaces, F2 appends)
 *   Enter / Alt+↓           on a dropdown cell, open its list (Excel's Alt+↓)
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Committed rows paginate by infinite scroll: only the latest LOAD_CHUNK are
 * rendered at first (the entry rows sit at the bottom, so that's where the
 * user starts), and scrolling up past the sentinel loads older chunks. All
 * selection/clipboard logic keeps using absolute row indices over the full
 * dataset, so ranges spanning unrendered rows still copy correctly.
 */
const LOAD_CHUNK = 100;

/** NEW ENTRIES dock sizing: default cap, and the floors either side keeps. */
const DOCK_DEFAULT_MAX = 208;
const DOCK_MIN = 60;
const LIST_MIN = 140;
const DOCK_HEIGHT_KEY = "sheet-grid.dockHeight";

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
  /** Autocomplete suggestions offered while editing (typeahead dropdown). */
  options?: Array<string | SheetSuggestion>;
  /**
   * Always present this column as a dropdown cell (chevron, Enter opens the
   * list) even when its suggestions arrive lazily — e.g. bonus plans fetched
   * per player once the edit starts. Columns with static `options` are
   * dropdown cells automatically.
   */
  dropdown?: boolean;
  /**
   * Ghost hint shown in this cell while empty — but only on the first entry row
   * that's still blank, so it reads as a template for the next row to fill,
   * never as clutter down the whole panel.
   */
  placeholder?: string;
};

/**
 * One typeahead entry. The compact form is value + hint (member codes, games).
 * Entries with a `title` render as rich two-line rows — name with a badge,
 * a detail line, a right-aligned figure — the way the Deposits page presents
 * bonus plans. `disabled` rows show (with their reason) but can't be picked.
 */
export type SheetSuggestion = {
  /** What lands in the cell when picked. */
  value: string;
  hint?: string;
  title?: string;
  badge?: string;
  detail?: string;
  detailTone?: "default" | "warning";
  figure?: string;
  disabled?: boolean;
  /**
   * A command, not a value: picking it calls the grid's `onSuggestionAction`
   * instead of writing anything into the cell — "＋ New player", say.
   *
   * Action rows survive filtering and always sit last, so the offer is still
   * there when a typed code matches nothing, which is exactly when it's
   * wanted. They're the reason the list can open with no ordinary matches.
   */
  action?: boolean;
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
  /**
   * Opened as a dropdown (Enter / Alt+↓ / chevron click): the full list shows
   * with the current value highlighted, and typing starts filtering.
   */
  browse: boolean;
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

/**
 * Rows are not tinted by status.
 *
 * Every sheet used to paint whole rows green/red/amber by their status, which
 * on a screen showing several hundred at once read as noise rather than
 * signal — and the Status column already says the same thing in words, without
 * asking anyone to remember what amber meant. Plain foreground, so the theme
 * decides: black on light, white on dark.
 *
 * `SheetRow.tone` is still accepted and still set by the pages; it simply is
 * not painted. Keeping it means the semantics survive if a future design wants
 * a subtler marker (a left border, an icon) instead of colouring the text.
 */

/** Selection slice handed to a row — computed narrow so memo() can bite. */
/**
 * This row's share of the selection.
 *
 * `spans` is a list because Ctrl+click builds a discontiguous selection the way
 * Excel does, and one row can fall inside several of its rectangles. Encoded as
 * "c1:c2,c1:c2" rather than an array so memo() keeps comparing it by value — an
 * array literal would be a new object on every render and defeat the memo on
 * every row in the sheet.
 */
type RowSel = { spans: string; anchorC: number } | null;

/** An inclusive rectangle of cells. */
type Bounds = { r1: number; r2: number; c1: number; c2: number };

/**
 * Right edge of a range that means "however wide this row is".
 *
 * Saved rows and entry rows carry different column counts, so a whole-row
 * selection cannot name one number. Anything reading a range clamps to the
 * row's own width; anything merely testing membership compares and is right.
 */
const WHOLE_ROW = Number.MAX_SAFE_INTEGER;

/** "1:4,7:9" → does any span cover this column? */
function spansCover(spans: string, c: number): boolean {
  for (const part of spans.split(",")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    if (c >= +part.slice(0, i) && c <= +part.slice(i + 1)) return true;
  }
  return false;
}

const GridRow = memo(function GridRow({
  rIdx,
  gutter,
  gutterTitle,
  marker,
  cells,
  columns,
  isDraft,
  firstDraft,
  showPlaceholder,
  sel,
  editing,
  editorProps,
  dropdownCols,
  onCellMouseDown,
  onCellMouseEnter,
  onCellDoubleClick,
  onDropdownOpen,
}: {
  rIdx: number;
  gutter: string;
  gutterTitle?: string;
  marker: "ready" | "error" | null;
  cells: string[];
  columns: SheetColumn[];
  isDraft: boolean;
  firstDraft: boolean;
  /** This is the first still-blank entry row — show column placeholders here. */
  showPlaceholder: boolean;
  sel: RowSel;
  /** Column being edited in this row, or -1. */
  editing: number;
  editorProps: EditorProps | null;
  /**
   * Columns of this row that behave as dropdown cells (editable + a list to
   * pick from), as a comma-joined string so memo() compares it by value.
   */
  dropdownCols: string;
  onCellMouseDown: (r: number, c: number, shift: boolean, mod: boolean) => void;
  onCellMouseEnter: (r: number, c: number) => void;
  onCellDoubleClick: (r: number, c: number) => void;
  /** The chevron was clicked: select the cell and open its list. */
  onDropdownOpen: (r: number, c: number) => void;
}) {
  const dropdownSet = useMemo(
    () => new Set(dropdownCols ? dropdownCols.split(",").map(Number) : []),
    [dropdownCols],
  );
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
        const selected = sel !== null && spansCover(sel.spans, c);
        const isAnchor = sel !== null && c === sel.anchorC;
        const isEditing = editing === c;
        const isDropdown = dropdownSet.has(c);
        return (
          <td
            key={col.key}
            data-cell={`${rIdx}-${c}`}
            onMouseDown={(e) => {
              /**
               * Shift-click extends, Ctrl/Cmd-click adds a separate rectangle,
               * both as Excel does.
               *
               * macOS turns Ctrl+click into a secondary click, so depending on
               * the browser it arrives as button 0 or button 2. Taking it
               * either way means the shortcut the desk asked for works on a
               * Mac as well as on Windows; a plain right-click (button 2 with
               * no modifier) is still left alone.
               */
              const mod = e.ctrlKey || e.metaKey;
              if (e.button === 0 || (e.button === 2 && mod)) {
                onCellMouseDown(rIdx, c, e.shiftKey, mod);
              }
            }}
            onContextMenu={(e) => {
              // No menu over a selection the user is building.
              if (e.ctrlKey || e.metaKey) e.preventDefault();
            }}
            onMouseEnter={() => onCellMouseEnter(rIdx, c)}
            onDoubleClick={() => onCellDoubleClick(rIdx, c)}
            className={cn(
              "relative cursor-cell select-none overflow-hidden whitespace-nowrap border-b border-r border-border px-1.5 text-[13px]",
              col.align === "right" && "text-right tabular-nums",
              col.align === "center" && "text-center",
              isDraft && !col.entry && "italic text-muted-foreground",
              // Room for the chevron, so the value never runs underneath it.
              isDropdown && "pr-5",
              selected && "bg-emerald-600/10 dark:bg-emerald-400/10",
              isAnchor &&
                "outline outline-2 -outline-offset-1 outline-emerald-600 dark:outline-emerald-400",
            )}
          >
            {isEditing && editorProps ? (
              <CellEditor {...editorProps} />
            ) : (cells[c] ?? "") ? (
              cells[c]
            ) : showPlaceholder && col.entry && col.placeholder ? (
              <span className="italic text-muted-foreground/45">{col.placeholder}</span>
            ) : (
              ""
            )}
            {isDropdown && !isEditing && (
              // Excel's data-validation arrow: a faint hint on every list
              // cell, and a proper button on the active one. mousedown (not
              // click) so it wins over the cell's own select-on-mousedown.
              <button
                type="button"
                tabIndex={-1}
                aria-label="Open list"
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onDropdownOpen(rIdx, c);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                className={cn(
                  "absolute inset-y-0 right-0 flex w-4 cursor-pointer items-center justify-center",
                  isAnchor
                    ? "border-l border-border bg-muted text-foreground hover:bg-emerald-600/20 dark:hover:bg-emerald-400/20"
                    : "text-muted-foreground/40 hover:text-foreground",
                )}
              >
                <ChevronDown className="size-3" strokeWidth={isAnchor ? 2.25 : 2} />
              </button>
            )}
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
  align?: "left" | "right" | "center";
  /** Typeahead entries for this column; empty/absent = plain text editing. */
  suggestions?: SheetSuggestion[];
  /** Opened as a dropdown: show the whole list, current value highlighted. */
  browse: boolean;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  /** Accept a suggestion: write `value` into the cell and move on. */
  onPick: (value: string, move: "down" | "right" | "left" | "up" | "none") => void;
  /** Run an `action` suggestion. Nothing is written; the edit is abandoned. */
  onAction: (value: string, typed: string) => void;
  /**
   * Ask the owner for suggestions matching what has been typed, instead of
   * filtering a list held in the browser.
   *
   * Member codes outgrew the browser: twelve thousand of them cannot be shipped
   * to filter client-side. When this is set the editor debounces the keystrokes
   * and shows what comes back; `suggestions` is then only the fallback shown
   * before the first reply lands, plus any action rows, which are never
   * filtered and never fetched.
   */
  onQuery?: (query: string) => Promise<SheetSuggestion[]>;
};

/** How many suggestions the typeahead shows while filtering. */
const MAX_SUGGESTIONS = 8;
/**
 * How many the list shows when opened as a dropdown (Enter / Alt+↓ / chevron)
 * before any typing — it scrolls, like Excel's validation list, but a
 * thousand member codes is still a wall, so it's capped and typing filters.
 */
const MAX_BROWSE = 100;

/**
 * The in-cell editor, with an Excel-style typeahead: matching suggestions drop
 * down as you type, ↑/↓ walks them, Enter/Tab takes the highlighted one and
 * moves on, Esc closes the list first and cancels the edit second. Nothing is
 * forced — with no row highlighted, Enter keeps exactly what was typed.
 *
 * The list renders through a portal: the cell clips overflow and the grid
 * scrolls, so an in-cell dropdown would be cut off at the first row boundary.
 */
function CellEditor({
  value,
  align,
  suggestions,
  browse,
  onChange,
  onKeyDown,
  onBlur,
  onPick,
  onAction,
  onQuery,
}: EditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const [highlight, setHighlight] = useState(-1);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // Browse mode ignores the cell's current value as a filter until the user
  // actually types — the point of opening the list is to see all of it.
  const [browsing, setBrowsing] = useState(browse);

  useEffect(() => {
    ref.current?.focus();
    if (browse) {
      // Excel's dropdown: the value is shown selected, so typing replaces it
      // and starts filtering from scratch.
      ref.current?.setSelectionRange(0, value.length);
    } else {
      // Caret at the end, matching Excel's edit-in-place feel.
      ref.current?.setSelectionRange(value.length, value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Server-side matches for the current text, when the owner fetches them.
   *
   * Debounced, and stamped with the query it answers so a slow reply for "GA1"
   * cannot land after a fast one for "GA12" and overwrite it.
   */
  const [remote, setRemote] = useState<SheetSuggestion[] | null>(null);
  const queryRef = useRef("");
  useEffect(() => {
    if (!onQuery) return;
    const q = value.trim();
    queryRef.current = q;
    const timer = setTimeout(() => {
      void onQuery(q).then((rows) => {
        if (queryRef.current === q) setRemote(rows);
      });
    }, 160);
    return () => clearTimeout(timer);
  }, [value, onQuery]);

  const matches = useMemo(() => {
    if (onQuery) {
      // The server has already matched; only the commands are added here.
      const actions = (suggestions ?? []).filter((sg) => sg.action);
      const rows = remote ?? (suggestions ?? []).filter((sg) => !sg.action).slice(0, MAX_SUGGESTIONS);
      return [...rows.slice(0, browsing ? MAX_BROWSE : MAX_SUGGESTIONS), ...actions];
    }
    if (!suggestions?.length) return [];
    // Commands are not candidates: they never filter out, and they go last.
    const actions = suggestions.filter((sg) => sg.action);
    const values = actions.length ? suggestions.filter((sg) => !sg.action) : suggestions;
    if (browsing) return [...values.slice(0, MAX_BROWSE), ...actions];
    const q = value.trim().toLowerCase();
    const starts: SheetSuggestion[] = [];
    const contains: SheetSuggestion[] = [];
    for (const sg of values) {
      if (!q) {
        starts.push(sg);
      } else {
        const v = sg.value.toLowerCase();
        if (v.startsWith(q)) starts.push(sg);
        else if (
          v.includes(q) ||
          sg.hint?.toLowerCase().includes(q) ||
          sg.title?.toLowerCase().includes(q) ||
          sg.detail?.toLowerCase().includes(q)
        ) {
          contains.push(sg);
        }
      }
      if (starts.length >= MAX_SUGGESTIONS) break;
    }
    return [...[...starts, ...contains].slice(0, MAX_SUGGESTIONS), ...actions];
  }, [suggestions, value, browsing, onQuery, remote]);

  /** Take a row: run it if it's a command, otherwise write it into the cell. */
  const take = (sg: SheetSuggestion, move: "right" | "left" | "none") => {
    if (sg.action) onAction(sg.value, value.trim());
    else onPick(sg.value, move);
  };

  /** Walk the highlight up/down, skipping rows that can't be picked. */
  const stepHighlight = (dir: 1 | -1) =>
    setHighlight((h) => {
      let i = h;
      for (let k = 0; k < matches.length; k++) {
        i = (i + dir + matches.length) % matches.length;
        if (i < 0) i = matches.length - 1;
        if (!matches[i]?.disabled) return i;
      }
      return h;
    });

  // Opened as a dropdown: land the highlight on the cell's current value (or
  // the first pickable row), so Enter straight away re-confirms it and ↑/↓
  // step from where the cell already is — the way Excel's list opens.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!browsing || seededRef.current || !matches.length) return;
    seededRef.current = true;
    const cur = value.trim().toLowerCase();
    let i = cur ? matches.findIndex((m) => !m.disabled && m.value.toLowerCase() === cur) : -1;
    if (i < 0) i = matches.findIndex((m) => !m.disabled);
    // Subscription-style: reacts to the (possibly lazy) list arriving.
    setHighlight(i);
  }, [browsing, matches, value]);

  // Keep the highlighted row in view as ↑/↓ walk past the list's edge.
  useEffect(() => {
    if (highlight < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // Anchor the portal to the input; re-measure as typing changes the matches.
  useLayoutEffect(() => {
    setRect(ref.current?.getBoundingClientRect() ?? null);
  }, [value, matches.length]);

  const showList = open && matches.length > 0;
  const hasRich = matches.some((m) => m.title !== undefined);
  // Flip above the cell when there's no room below — the entry dock lives at
  // the bottom of the window, so this is the common case, not the edge case.
  const listMaxH = hasRich ? 320 : 232;
  const openUp = rect ? rect.bottom + listMaxH + 4 > window.innerHeight : false;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Alt+↓ — Excel's "open the list" key — brings the full list back after
    // an Esc, or when typing filtered everything away.
    if (e.altKey && e.key === "ArrowDown" && suggestions?.length) {
      e.preventDefault();
      seededRef.current = false;
      setBrowsing(true);
      setOpen(true);
      return;
    }
    if (showList) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        stepHighlight(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        stepHighlight(-1);
        return;
      }
      if (
        (e.key === "Enter" || e.key === "Tab") &&
        !e.ctrlKey &&
        !e.metaKey &&
        highlight >= 0 &&
        !matches[highlight]?.disabled
      ) {
        e.preventDefault();
        // Enter accepts and stays on the cell (combobox-style) — jumping a row
        // down mid-entry loses the row being filled. Tab accepts and moves on.
        take(
          matches[highlight],
          e.key === "Tab" ? (e.shiftKey ? "left" : "right") : "none",
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        setHighlight(-1);
        return;
      }
    }
    onKeyDown(e);
  };

  return (
    <>
      <input
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setBrowsing(false);
          setOpen(true);
          setHighlight(-1);
        }}
        onKeyDown={handleKeyDown}
        onBlur={onBlur}
        className={cn(
          "absolute inset-0 z-10 w-full border-2 border-emerald-600 bg-background px-1 text-[13px] outline-none dark:border-emerald-400",
          !!suggestions?.length && "pr-5",
          align === "right" && "text-right",
          align === "center" && "text-center",
        )}
      />
      {!!suggestions?.length && (
        // The chevron stays while editing and toggles the list — mousedown
        // is prevented so the input keeps focus and nothing commits.
        <button
          type="button"
          tabIndex={-1}
          aria-label={showList ? "Close list" : "Open list"}
          onMouseDown={(e) => {
            e.preventDefault();
            if (showList) {
              setOpen(false);
              setHighlight(-1);
            } else {
              seededRef.current = false;
              setBrowsing(true);
              setOpen(true);
            }
          }}
          className="absolute inset-y-0.5 right-0.5 z-20 flex w-4 cursor-pointer items-center justify-center bg-muted text-foreground hover:bg-emerald-600/20 dark:hover:bg-emerald-400/20"
        >
          <ChevronDown
            className={cn("size-3 transition-transform", showList && "rotate-180")}
            strokeWidth={2.25}
          />
        </button>
      )}
      {showList &&
        rect &&
        createPortal(
          <div
            style={{
              position: "fixed",
              // Clamp into the viewport — the bonus column sits near the right
              // edge, and a menu wider than the cell would otherwise clip.
              left: Math.max(
                8,
                Math.min(
                  rect.left,
                  window.innerWidth - Math.max(rect.width, hasRich ? 290 : 180) - 8,
                ),
              ),
              minWidth: Math.max(rect.width, hasRich ? 290 : 180),
              maxHeight: listMaxH,
              ...(openUp
                ? { bottom: window.innerHeight - rect.top + 2 }
                : { top: rect.bottom + 2 }),
            }}
            ref={listRef}
            className="z-50 overflow-y-auto rounded-md border border-border bg-popover py-0.5 shadow-lg"
          >
            {matches.map((sg, i) =>
              sg.title !== undefined ? (
                // Rich row — the BonusPicker look: name + badge, detail line,
                // figure on the right; disabled rows show their reason greyed.
                <div
                  key={`${sg.title}-${i}`}
                  data-idx={i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (!sg.disabled) take(sg, "none");
                  }}
                  onMouseEnter={() => {
                    if (!sg.disabled) setHighlight(i);
                  }}
                  className={cn(
                    "flex items-start justify-between gap-2 border-b border-border px-2.5 py-2 text-left last:border-b-0",
                    sg.disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
                    // A command reads as a footer to the list, not another
                    // candidate in it.
                    sg.action &&
                      "sticky bottom-0 border-t bg-background font-medium text-emerald-700 dark:text-emerald-400",
                    i === highlight && !sg.disabled && "bg-emerald-600/15 dark:bg-emerald-400/20",
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{sg.title}</span>
                      {sg.badge && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                          {sg.badge}
                        </span>
                      )}
                    </span>
                    {sg.detail && (
                      <span
                        className={cn(
                          "mt-0.5 block text-[11px] leading-snug",
                          sg.detailTone === "warning"
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-muted-foreground",
                        )}
                      >
                        {sg.detail}
                      </span>
                    )}
                  </span>
                  {sg.figure !== undefined && (
                    <span
                      className={cn(
                        "shrink-0 text-[12px] font-semibold",
                        sg.disabled
                          ? "text-muted-foreground"
                          : "text-emerald-700 dark:text-emerald-400",
                      )}
                    >
                      {sg.figure}
                    </span>
                  )}
                </div>
              ) : (
                <div
                  key={sg.value}
                  data-idx={i}
                  // mousedown, and prevented: a click must not blur the input
                  // first, or the half-typed value commits before the pick lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    take(sg, "none");
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "flex cursor-pointer items-baseline gap-2 px-2 py-1 text-[13px]",
                    i === highlight && "bg-emerald-600/15 dark:bg-emerald-400/20",
                  )}
                >
                  <span className="font-medium">{sg.value}</span>
                  {sg.hint && (
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                      {sg.hint}
                    </span>
                  )}
                </div>
              ),
            )}
            <div className="border-t border-border px-2 py-0.5 text-[10px] text-muted-foreground">
              ↑↓ pick · Enter accept · Tab accept + next · Esc close
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The green column-label band. Sits under the letters row on the saved list
 * and at the very top of the NEW ENTRIES dock, so the labels are in view
 * wherever the user is typing — the dock is where entry happens, and the
 * saved list's header is often scrolled far above it.
 */
function LabelHeaderRow({
  columns,
  offset,
}: {
  columns: SheetColumn[];
  /** Sticky offset: under the letters row ("top-5") or flush ("top-0"). */
  offset: "top-0" | "top-5";
}) {
  return (
    <tr className="h-7">
      <th
        className={cn(
          "sticky left-0 z-30 border-b border-r border-border bg-emerald-700 dark:bg-emerald-800",
          offset,
        )}
      />
      {columns.map((c) => (
        <th
          key={c.key}
          title={c.entry ? undefined : "Filled in by the CRM — not saved from entry rows"}
          className={cn(
            "sticky z-20 select-none overflow-hidden whitespace-nowrap border-b border-r border-emerald-800 bg-emerald-700 px-1.5 text-left text-[12px] font-semibold text-white dark:border-emerald-700 dark:bg-emerald-800",
            offset,
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
      <th
        className={cn(
          "sticky z-20 border-b border-emerald-800 bg-emerald-700 dark:border-emerald-700 dark:bg-emerald-800",
          offset,
        )}
      />
    </tr>
  );
}

export function SheetGrid({
  columns,
  rows,
  drafts,
  onDraftsChange,
  draftStatus,
  onCommit,
  entryColumns: entryColumnsProp,
  flushRef,
  readOnly = false,
  /** Changing this key re-scrolls to the entry area and selects its first cell. */
  focusKey,
  committedEditable,
  onCommittedEdit,
  onSelectedRowsChange,
  draftSuggestions,
  committedSuggestions,
  onEditStart,
  onSuggestionAction,
  suggestionQuery,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: {
  columns: SheetColumn[];
  rows: SheetRow[];
  drafts: string[][];
  onDraftsChange: (next: string[][]) => void;
  draftStatus: (draft: string[], index: number) => DraftStatus;
  onCommit: () => void;
  /**
   * The NEW ENTRIES dock's own columns, when they differ from the saved list's.
   *
   * The two areas answer different questions. The list reports what a member
   * has done — status, deposits, withdrawals, last deposit — none of which
   * exists before they do. The dock asks what it takes to create one: a name,
   * a prefix, the product and login they play under. Neither set is a subset
   * of the other, so the dock gets its own.
   *
   * Drafts are then rows of THIS shape, and every column lookup below picks
   * the array that matches the row it is looking at.
   */
  entryColumns?: SheetColumn[];
  /**
   * Handed a function that commits whatever cell is mid-edit, and returns what
   * it wrote so a save firing in the same tick can see it.
   *
   * Clicking Save blurs the editor, which commits. The keyboard shortcut does
   * not: it is caught on window in capture, so the editor never sees the key,
   * and a row saved straight after typing its last cell went in without that
   * cell — "Bad amount """ on a row with an amount typed into it.
   */
  flushRef?: React.MutableRefObject<
    null | (() => { draftIndex: number; col: number; value: string } | null)
  >;
  readOnly?: boolean;
  focusKey?: string;
  /**
   * Which committed cells may be edited in place (e.g. a pending deposit's
   * game or bonus). Absent = all committed cells are read-only.
   */
  committedEditable?: (rowIndex: number, colIndex: number) => boolean;
  /** Receives the edit of a committed cell; the parent persists it. */
  onCommittedEdit?: (rowIndex: number, colIndex: number, value: string) => void;
  /** Committed row ids inside the current selection — drives the action bar. */
  onSelectedRowsChange?: (ids: (string | number)[]) => void;
  /**
   * Per-cell typeahead for entry rows, overriding the column's static options
   * when it returns a list — e.g. the bonus plans this row's player actually
   * qualifies for. Return undefined to fall back to the column options.
   */
  draftSuggestions?: (draftIndex: number, colIndex: number) => SheetSuggestion[] | undefined;
  /** Same, for in-place edits of committed cells (a pending deposit's bonus). */
  committedSuggestions?: (rowIndex: number, colIndex: number) => SheetSuggestion[] | undefined;
  /** Fired as a cell edit begins — the moment to prefetch dynamic suggestions. */
  onEditStart?: (rowIndex: number, colIndex: number) => void;
  /**
   * An `action` suggestion was picked. The edit is abandoned first, so the
   * handler is free to open a dialog over the sheet; `typed` is whatever was
   * in the cell, which is usually what the new record should be called.
   */
  /**
   * Per-cell server-side typeahead. Return undefined to filter the column's
   * own list in the browser instead — the right choice for short lists.
   */
  /**
   * Fetch the next page, when the rows come from a server a page at a time.
   *
   * The grid's own infinite scroll only reveals rows it already holds. A list
   * too large to hold — the member roster — needs the owner to fetch more, so
   * reaching the end asks for them. `hasMore` says whether asking is worth it;
   * `loadingMore` keeps the request from being fired again while it is in
   * flight.
   */
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  suggestionQuery?: (
    rowIndex: number,
    colIndex: number,
  ) => ((query: string) => Promise<SheetSuggestion[]>) | undefined;
  onSuggestionAction?: (ctx: {
    /** Index into `drafts`, or null when the cell is a saved row. */
    draftIndex: number | null;
    rowIndex: number;
    colIndex: number;
    /** The suggestion's `value` — which command was chosen. */
    value: string;
    /** What was in the cell when it was chosen. */
    typed: string;
  }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** Scroll container of the committed rows (infinite-scroll root). */
  const mainScrollRef = useRef<HTMLDivElement>(null);
  /** Scroll container of the docked entry rows; x-synced with the main one. */
  const entryScrollRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<CellPos | null>(null);
  const [ext, setExt] = useState<CellPos | null>(null);
  /**
   * Rectangles already put down by Ctrl+click, not counting the live one.
   *
   * Excel lets you collect scattered rows into one selection, and the desk
   * wants it for the same reason: approving or deleting six rows that are not
   * next to each other. The live rectangle stays in sel/ext so every existing
   * behaviour — dragging, shift-extending, typing — is untouched; Ctrl+click
   * simply parks the current one here and starts a new one.
   */
  const [heldRanges, setHeldRanges] = useState<Bounds[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Height of the NEW ENTRIES dock. Null = the default (up to DOCK_DEFAULT_MAX,
   * hugging its rows); a number once the user has dragged the divider, kept
   * per browser so the split survives a reload.
   */
  const [dockHeight, setDockHeight] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(DOCK_HEIGHT_KEY));
      return Number.isFinite(v) && v >= DOCK_MIN ? v : null;
    } catch {
      return null;
    }
  });
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  /** Drag the divider: up grows the dock, down shrinks it, within limits. */
  const onDividerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    // The dock's scroll area is the last child of the divider's parent.
    const dock = target.parentElement?.lastElementChild as HTMLElement | null;
    const startH = dock?.getBoundingClientRect().height ?? DOCK_DEFAULT_MAX;
    dragRef.current = { startY: e.clientY, startH };
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // The saved list keeps at least a few rows; the dock keeps at least one.
      const total = containerRef.current?.getBoundingClientRect().height ?? 600;
      const max = Math.max(DOCK_MIN, total - LIST_MIN);
      const next = Math.min(max, Math.max(DOCK_MIN, d.startH + (d.startY - ev.clientY)));
      setDockHeight(Math.round(next));
    };
    const up = () => {
      dragRef.current = null;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDockHeight((h) => {
        try {
          if (h === null) localStorage.removeItem(DOCK_HEIGHT_KEY);
          else localStorage.setItem(DOCK_HEIGHT_KEY, String(h));
        } catch {
          // storage blocked — the split just won't persist
        }
        return h;
      });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }, []);

  /** Double-click the divider: back to the default split. */
  const resetDock = useCallback(() => {
    setDockHeight(null);
    try {
      localStorage.removeItem(DOCK_HEIGHT_KEY);
    } catch {
      // ignore
    }
  }, []);
  const draggingRef = useRef(false);
  /**
   * Where the current Tab-run began. Excel's Enter-after-Tab rule: type across
   * a row with Tab, press Enter, and the cursor returns to the column the run
   * started in, one row down — that is how a sheet person enters row after row
   * without ever touching the mouse. Cleared by arrows, clicks and Escape.
   */
  const tabOriginRef = useRef<CellPos | null>(null);
  /**
   * True once the current edit session has been resolved (committed or
   * cancelled). The editor input blurs when it unmounts, and that blur handler
   * closes over the previous render's editing state — without this guard it
   * would re-commit the stale typed value right over a just-picked suggestion.
   */
  const editDoneRef = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nRows = rows.length + drafts.length;
  const nCols = columns.length;
  const draftStart = rows.length;

  // ---- infinite scroll over the committed rows ----

  // How many of the latest committed rows are rendered; older ones mount as
  // the user scrolls up past the sentinel.
  const [visibleCount, setVisibleCount] = useState(LOAD_CHUNK);
  const hiddenAbove = Math.max(0, rows.length - visibleCount);
  const visibleRows = hiddenAbove ? rows.slice(hiddenAbove) : rows;
  const topSentinelRef = useRef<HTMLTableRowElement>(null);
  // scrollHeight snapshot taken when a chunk load starts, so the viewport can
  // be held still while older rows are prepended above it.
  const prevScrollHeightRef = useRef<number | null>(null);
  /**
   * Cell to bring into view once the chunk containing it has rendered.
   *
   * `edge` marks a deliberate jump to the very top or bottom. Those cannot be
   * done by measuring a cell: arriving at the top wakes the sentinel that
   * loads the next chunk, and the rows that mount above shift everything that
   * was just measured. Pinning the scroller to 0 or to its full height is the
   * one instruction that stays true however much loads in afterwards.
   */
  const pendingScrollRef = useRef<(CellPos & { edge?: "top" | "bottom" }) | null>(null);

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

  /** Everything selected: the rectangles held plus the live one. */
  const allRanges = useMemo(
    () => (bounds ? [...heldRanges, bounds] : heldRanges),
    [heldRanges, bounds],
  );

  /**
   * Which columns of each row are selected, as "c1:c2,c1:c2".
   *
   * Built once per selection change rather than per row: with a few hundred
   * rows on screen, testing every rectangle against every row on every render
   * is the kind of thing that makes typing feel heavy.
   */
  const spansByRow = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of allRanges) {
      for (let r = b.r1; r <= b.r2; r++) {
        const at = m.get(r);
        m.set(r, at ? `${at},${b.c1}:${b.c2}` : `${b.c1}:${b.c2}`);
      }
    }
    return m;
  }, [allRanges]);

  /**
   * Bring a cell into view, measuring rather than asking the browser.
   *
   * This used to call scrollIntoView({ block: "nearest" }), which reads a cell
   * as already visible whenever it sits inside the scrollport — even when the
   * sticky header or the sticky row-number gutter is painted on top of it. So
   * Ctrl+↑ selected the first row and scrolled nowhere: the row was "visible"
   * to the browser and underneath the header to the reader.
   *
   * Measuring against the header's bottom edge and the gutter's right edge
   * instead means "in view" means what the desk means by it.
   */
  const scrollCellIntoView = useCallback((r: number, c: number) => {
    const GUTTER = 44;
    const attempt = () => {
      const el = containerRef.current?.querySelector(
        `[data-cell="${r}-${c}"]`,
      ) as HTMLElement | null;
      if (!el) return false;
      const scroller = mainScrollRef.current?.contains(el)
        ? mainScrollRef.current
        : entryScrollRef.current?.contains(el)
          ? entryScrollRef.current
          : null;
      if (!scroller) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        return true;
      }
      const box = scroller.getBoundingClientRect();
      const cell = el.getBoundingClientRect();
      const head = scroller.querySelector("thead");
      const topEdge = head ? head.getBoundingClientRect().bottom : box.top;
      if (cell.top < topEdge) scroller.scrollTop -= topEdge - cell.top;
      else if (cell.bottom > box.bottom) scroller.scrollTop += cell.bottom - box.bottom;
      const leftEdge = box.left + GUTTER;
      if (cell.left < leftEdge) scroller.scrollLeft -= leftEdge - cell.left;
      else if (cell.right > box.right) scroller.scrollLeft += cell.right - box.right;
      return true;
    };
    /**
     * Measure now, then once more after paint.
     *
     * The first pass keeps single-step arrows feeling immediate. The second
     * catches the cases the first cannot see: a row that was not in the DOM
     * yet, and a jump taken before React had re-rendered around it. The maths
     * is a no-op when the cell is already in view, so running it twice costs
     * nothing and never fights the user's own scrolling.
     */
    attempt();
    requestAnimationFrame(() => void attempt());
  }, []);

  /**
   * Pin the saved-rows scroller to its very top or bottom, and hold it there.
   *
   * Arriving at the top wakes the sentinel that loads the next chunk of older
   * rows; those rows mount above and push everything down. A one-shot scroll
   * lands correctly and is then dragged away, which is exactly what Ctrl+↑
   * looked like — the selection was on the first row and the view was not.
   *
   * So the instruction is re-applied over the next few frames. It is an
   * absolute position rather than a measurement, so repeating it is harmless,
   * and it stops as soon as the user scrolls themselves — nothing here should
   * be able to trap the viewport.
   */
  const scrollToEdge = useCallback((edge: "top" | "bottom") => {
    const root = mainScrollRef.current;
    if (!root) return;
    let frames = 6;
    let last = -1;
    const pin = () => {
      // Someone scrolled between frames — their intent wins, stop pinning.
      if (last >= 0 && Math.abs(root.scrollTop - last) > 2) return;
      root.scrollTop = edge === "top" ? 0 : root.scrollHeight;
      last = root.scrollTop;
      if (--frames > 0) requestAnimationFrame(pin);
    };
    pin();
  }, []);

  /** The dock's columns — its own when given, otherwise the list's. */
  const entryColumns = entryColumnsProp ?? columns;
  /** The column list that governs a given row. */
  const colsFor = useCallback(
    (r: number) => (r >= draftStart ? entryColumns : columns),
    [draftStart, entryColumns, columns],
  );

  const moveTo = useCallback(
    (r: number, c: number, extend = false) => {
      const nr = Math.max(0, Math.min(nRows - 1, r));
      // An entry row is only as wide as the dock draws it; without this, Tab
      // off the last entry cell parked the cursor on a column that isn't there.
      const lastCol = (nr >= draftStart ? entryColumns.length : nCols) - 1;
      const nc = Math.max(0, Math.min(lastCol, c));
      if (extend) {
        setExt({ r: nr, c: nc });
      } else {
        // Moving the cursor collapses the selection, scattered parts included.
        setHeldRanges([]);
        setSel({ r: nr, c: nc });
        setExt(null);
      }
      const edge = nr === 0 ? "top" : nr === draftStart - 1 ? "bottom" : undefined;
      if (nr < hiddenAbove) {
        // Target row isn't rendered yet (PageUp / Ctrl+A / Home runs) — load
        // enough older rows to include it, then scroll once they exist.
        // Anchoring is cancelled: it exists to hold the viewport still while
        // older rows arrive, which is the opposite of what a jump wants.
        prevScrollHeightRef.current = null;
        setVisibleCount(Math.min(rows.length, rows.length - nr + 20));
        pendingScrollRef.current = { r: nr, c: nc, edge };
      } else if (edge) {
        scrollToEdge(edge);
      } else {
        scrollCellIntoView(nr, nc);
      }
    },
    [
      nRows,
      nCols,
      hiddenAbove,
      rows.length,
      scrollCellIntoView,
      scrollToEdge,
      draftStart,
      entryColumns.length,
    ],
  );

  // Load the next older chunk whenever the sentinel row scrolls into view.
  useEffect(() => {
    if (!hiddenAbove) return;
    const root = mainScrollRef.current;
    const el = topSentinelRef.current;
    if (!root || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((en) => en.isIntersecting)) return;
        if (prevScrollHeightRef.current === null) {
          prevScrollHeightRef.current = root.scrollHeight;
        }
        setVisibleCount((v) => Math.min(rows.length, v + LOAD_CHUNK));
      },
      // Start loading a couple hundred px before the sentinel is actually
      // visible so fast scrolling rarely hits the placeholder.
      { root, rootMargin: "240px 0px 0px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hiddenAbove, rows.length]);

  /**
   * Ask the owner for the next page as the end of the list comes into view.
   *
   * Only once everything already fetched is on screen: while rows are still
   * hidden above, the reader has not reached the end of what we hold.
   */
  const bottomSentinelRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!onLoadMore || !hasMore || loadingMore) return;
    const root = mainScrollRef.current;
    const el = bottomSentinelRef.current;
    if (!root || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) onLoadMore();
      },
      { root, rootMargin: "0px 0px 320px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onLoadMore, hasMore, loadingMore, rows.length]);

  // After a chunk mounts above the viewport, push scrollTop down by exactly
  // the added height so the rows the user was looking at don't jump.
  useLayoutEffect(() => {
    const root = mainScrollRef.current;
    const jump = pendingScrollRef.current;
    // Holding the viewport still is right for a passive load and wrong for a
    // jump the user asked for, so the jump wins and the anchor is dropped.
    if (root && prevScrollHeightRef.current !== null) {
      if (!jump) root.scrollTop += root.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = null;
    }
    if (jump) {
      pendingScrollRef.current = null;
      if (jump.edge) scrollToEdge(jump.edge);
      else scrollCellIntoView(jump.r, jump.c);
    }
  }, [visibleCount, scrollCellIntoView, scrollToEdge]);

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
    (r: number, c: number, seed?: string, browse = false) => {
      if (readOnly) return;
      if (r < draftStart && !committedEditable?.(r, c)) {
        flash(
          "This cell is read-only — add rows in the NEW ENTRIES panel below; on pending deposits the Member/Product/Bonus % cells edit in place.",
        );
        return;
      }
      /**
       * An entry row only takes typing in its entry columns.
       *
       * This guard existed for saved rows but not for drafts, so every derived
       * cell in the NEW ENTRIES panel opened an editor: the member code built
       * from the prefix, a deposit's bonus and total. Whatever was typed then
       * vanished the moment the cell it derives from changed, which reads as
       * the sheet eating the input.
       */
      if (r >= draftStart && !entryColumns[c]?.entry) {
        flash("That cell fills itself from the others — nothing to type here.");
        return;
      }
      editDoneRef.current = false;
      onEditStart?.(r, c);
      setEditing({
        r,
        c,
        value: seed !== undefined ? seed : cellValue(r, c),
        replace: seed !== undefined,
        browse,
      });
    },
    [readOnly, draftStart, cellValue, flash, committedEditable, onEditStart, entryColumns],
  );

  const commitWith = useCallback(
    (value: string, move: "down" | "right" | "left" | "up" | "none") => {
      if (!editing || editDoneRef.current) return;
      editDoneRef.current = true;
      if (editing.r < draftStart) {
        // In-place edit of a committed cell — hand it to the parent, and only
        // when it actually changed (a click-away commit shouldn't PATCH).
        if (value !== (rows[editing.r]?.cells[editing.c] ?? "")) {
          onCommittedEdit?.(editing.r, editing.c, value);
        }
      } else {
        setDraftCell(editing.r, editing.c, value);
      }
      setEditing(null);
      // Refocus the wrapper so the next keystroke keeps navigating.
      containerRef.current?.focus();
      if (move === "right") {
        // First Tab on this row starts (or restarts) the Tab-run.
        if (!tabOriginRef.current || tabOriginRef.current.r !== editing.r) {
          tabOriginRef.current = { r: editing.r, c: editing.c };
        }
        moveTo(editing.r, editing.c + 1);
      } else if (move === "down") {
        // Enter after a Tab-run: back to the run's starting column, next row.
        const origin = tabOriginRef.current;
        tabOriginRef.current = null;
        moveTo(
          editing.r + 1,
          origin && origin.r === editing.r ? origin.c : editing.c,
        );
      } else if (move === "up") {
        tabOriginRef.current = null;
        moveTo(editing.r - 1, editing.c);
      } else if (move === "left") {
        moveTo(editing.r, editing.c - 1);
      }
    },
    [editing, draftStart, rows, onCommittedEdit, setDraftCell, moveTo],
  );

  /** Commit whatever is currently typed in the editor. */
  const commitEdit = useCallback(
    (move: "down" | "right" | "left" | "up" | "none") => {
      if (editing) commitWith(editing.value, move);
    },
    [editing, commitWith],
  );

  const cancelEdit = useCallback(() => {
    editDoneRef.current = true; // the unmount blur must not commit the value
    setEditing(null);
    containerRef.current?.focus();
  }, []);

  /** The typeahead list a given cell would get, dynamic sources first. */
  const suggestionsAt = useCallback(
    (r: number, c: number): SheetSuggestion[] | undefined =>
      (r >= draftStart
        ? draftSuggestions?.(r - draftStart, c)
        : committedSuggestions?.(r, c)) ??
      colsFor(r)[c]?.options?.map((o) => (typeof o === "string" ? { value: o } : o)),
    [draftStart, draftSuggestions, committedSuggestions, colsFor],
  );

  /** Can this cell be edited at all (an entry cell, or an editable saved one)? */
  const isEditableCell = useCallback(
    (r: number, c: number): boolean =>
      !readOnly &&
      (r >= draftStart ? !!entryColumns[c]?.entry : !!committedEditable?.(r, c)),
    [readOnly, draftStart, committedEditable, entryColumns],
  );

  /**
   * A dropdown cell: editable, and there's a list to pick from — static column
   * options, a column flagged `dropdown` (its list loads lazily), or a dynamic
   * per-cell list (a player's logins, their bonus plans).
   */
  const isDropdownCell = useCallback(
    (r: number, c: number): boolean => {
      if (!isEditableCell(r, c)) return false;
      const col = colsFor(r)[c];
      if (col?.dropdown || col?.options?.length) return true;
      return !!suggestionsAt(r, c)?.length;
    },
    [isEditableCell, suggestionsAt, colsFor],
  );

  /**
   * Which columns of each rendered row are dropdown cells, as "0,6,7" strings
   * so the memoised rows only re-render when a row's set actually changes.
   */
  const dropdownColsByRow = useMemo(() => {
    const m = new Map<number, string>();
    if (readOnly) return m;
    const collect = (r: number) => {
      const cols: number[] = [];
      for (let c = 0; c < nCols; c++) if (isDropdownCell(r, c)) cols.push(c);
      if (cols.length) m.set(r, cols.join(","));
    };
    for (let i = 0; i < visibleRows.length; i++) collect(hiddenAbove + i);
    for (let i = 0; i < drafts.length; i++) collect(draftStart + i);
    return m;
  }, [readOnly, nCols, isDropdownCell, visibleRows.length, hiddenAbove, drafts.length, draftStart]);

  /**
   * Open a cell's list the Excel way (Enter, Alt+↓, or the chevron): select
   * it, then edit in browse mode — whole list, current value highlighted.
   * Landing on a cell never opens the list by itself — like Excel, the list
   * waits for the user to ask for it, so arrowing across a row stays quiet.
   */
  const pendingOpenRef = useRef<CellPos | null>(null);
  const openDropdown = useCallback(
    (r: number, c: number) => {
      if (editing) {
        if (editing.r === r && editing.c === c) return;
        // Another cell is mid-edit: commit it, and only start the new session
        // once that editor has unmounted — its unmount blur fires with the
        // old closure and would otherwise cancel the session opened here.
        pendingOpenRef.current = { r, c };
        commitEdit("none");
        setSel({ r, c });
        setExt(null);
        return;
      }
      setSel({ r, c });
      setExt(null);
      startEdit(r, c, undefined, true);
    },
    [editing, commitEdit, startEdit],
  );
  useEffect(() => {
    if (editing || !pendingOpenRef.current) return;
    const { r, c } = pendingOpenRef.current;
    pendingOpenRef.current = null;
    startEdit(r, c, undefined, true);
  }, [editing, startEdit]);

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
      if (readOnly) return;
      const text = e.clipboardData.getData("text/plain");
      // While editing, a single value pastes into the input natively; a block
      // with tabs/newlines is grid data — close the editor and spread it.
      if (editing) {
        if (!/[\t\n]/.test(text)) return;
        editDoneRef.current = true;
        setEditing(null);
        containerRef.current?.focus();
      }
      if (!text || !sel) return;
      e.preventDefault();
      if (sel.r < draftStart) {
        flash("Paste lands in the NEW ENTRIES panel — click a cell there first.");
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

  // Kept current with the edit in flight, so the page's save shortcut can
  // land the cell being typed before it reads the drafts.
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = () => {
      if (!editing) return null;
      const { r, c, value } = editing;
      commitEdit("none");
      return r >= draftStart ? { draftIndex: r - draftStart, col: c, value } : null;
    };
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, editing, commitEdit, draftStart]);

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
          setHeldRanges([]);
          setSel({ r: 0, c: 0 });
          setExt({ r: nRows - 1, c: nCols - 1 });
        }
        return;
      }
      /**
       * Copy/paste arrive via the clipboard events; don't swallow them here.
       *
       * The arrows are the exception: Ctrl+↑/↓ is a jump to the end of the
       * block and has to reach the switch below. Bailing out on every modified
       * key is what stopped it working the first time.
       */
      if (mod && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;

      if (!sel) {
        if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab", "Enter"].includes(e.key)) {
          e.preventDefault();
          moveTo(draftStart, 0);
        }
        return;
      }

      // On a dropdown cell, Enter (and Excel's Alt+↓) opens its list instead
      // of moving down — ↓ / Tab still move on; Esc closes it.
      if (
        ((e.key === "Enter" && !e.shiftKey) || (e.key === "ArrowDown" && e.altKey)) &&
        isDropdownCell(sel.r, sel.c)
      ) {
        e.preventDefault();
        openDropdown(sel.r, sel.c);
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          tabOriginRef.current = null;
          // Ctrl+Down runs to the end of the block the cursor is in, as Excel
          // does — the last saved row, or the last entry row if already in the
          // dock. Landing on a blank entry row from the middle of the day's
          // takings would be a jump to nowhere.
          if (mod) moveTo(sel.r >= draftStart ? nRows - 1 : draftStart - 1, sel.c, e.shiftKey);
          else if (e.shiftKey) moveTo((ext ?? sel).r + 1, (ext ?? sel).c, true);
          else moveTo(sel.r + 1, sel.c);
          break;
        case "ArrowUp":
          e.preventDefault();
          tabOriginRef.current = null;
          if (mod) moveTo(sel.r >= draftStart ? draftStart : 0, sel.c, e.shiftKey);
          else if (e.shiftKey) moveTo((ext ?? sel).r - 1, (ext ?? sel).c, true);
          else moveTo(sel.r - 1, sel.c);
          break;
        case "ArrowRight":
          e.preventDefault();
          tabOriginRef.current = null;
          if (e.shiftKey) moveTo((ext ?? sel).r, (ext ?? sel).c + 1, true);
          else moveTo(sel.r, sel.c + 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          tabOriginRef.current = null;
          if (e.shiftKey) moveTo((ext ?? sel).r, (ext ?? sel).c - 1, true);
          else moveTo(sel.r, sel.c - 1);
          break;
        case "Tab":
          e.preventDefault();
          if (!e.shiftKey && (!tabOriginRef.current || tabOriginRef.current.r !== sel.r)) {
            tabOriginRef.current = { r: sel.r, c: sel.c };
          }
          moveTo(sel.r, sel.c + (e.shiftKey ? -1 : 1));
          break;
        case "Enter": {
          e.preventDefault();
          // Excel's Enter-after-Tab: land on the column the Tab-run started in.
          const origin = tabOriginRef.current;
          tabOriginRef.current = null;
          if (!e.shiftKey && origin && origin.r === sel.r) {
            moveTo(sel.r + 1, origin.c);
          } else {
            moveTo(sel.r + (e.shiftKey ? -1 : 1), sel.c);
          }
          break;
        }
        case "Home":
          e.preventDefault();
          if (e.shiftKey) moveTo((ext ?? sel).r, 0, true);
          else moveTo(sel.r, 0);
          break;
        case "End":
          e.preventDefault();
          if (e.shiftKey) moveTo((ext ?? sel).r, nCols - 1, true);
          else moveTo(sel.r, nCols - 1);
          break;
        case "PageDown":
          e.preventDefault();
          if (e.shiftKey) moveTo((ext ?? sel).r + 20, (ext ?? sel).c, true);
          else moveTo(sel.r + 20, sel.c);
          break;
        case "PageUp":
          e.preventDefault();
          if (e.shiftKey) moveTo((ext ?? sel).r - 20, (ext ?? sel).c, true);
          else moveTo(sel.r - 20, sel.c);
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
            flash("Saved rows can't be deleted from here.");
          } else {
            clearDraftRange();
          }
          break;
        case "Escape":
          // Back to just the cell under the cursor, scattered parts dropped.
          setHeldRanges([]);
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
      isDropdownCell, openDropdown,
    ],
  );

  // ---- mouse ----

  const onCellMouseDown = useCallback(
    (r: number, c: number, shift: boolean, mod: boolean) => {
      if (editing) commitEdit("none");
      tabOriginRef.current = null;
      draggingRef.current = true;
      if (shift && sel) {
        // Extending grows the live rectangle; anything held stays held.
        setExt({ r, c });
      } else if (mod) {
        /**
         * Ctrl/Cmd+click picks whole rows, and picking the same row again
         * drops it.
         *
         * Excel would take the single cell, but nobody here is gathering
         * scattered cells — they are gathering rows to approve or delete, and
         * a row lit across only one column reads as a mis-click. WHOLE_ROW as
         * the right edge keeps it honest for both regions at once: saved rows
         * and entry rows have different column counts, and this needs no
         * arithmetic to cover either.
         */
        draggingRef.current = false; // picking rows, not dragging a range
        setHeldRanges((held) => {
          const at = held.findIndex((b) => b.r1 === r && b.r2 === r && b.c2 === WHOLE_ROW);
          if (at >= 0) return held.filter((_, i) => i !== at);
          const carried =
            bounds && !held.length
              ? [{ r1: bounds.r1, r2: bounds.r2, c1: 0, c2: WHOLE_ROW }]
              : [];
          return [...held, ...carried, { r1: r, r2: r, c1: 0, c2: WHOLE_ROW }];
        });
        setSel({ r, c });
        setExt(null);
      } else {
        // A plain click is a fresh start — it drops the scattered selection.
        setHeldRanges([]);
        setSel({ r, c });
        setExt(null);
      }
    },
    [editing, commitEdit, sel, bounds],
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

  // Tab switch / first load: focus the SAVED LIST (its last, newest row), not
  // the entry cell. Keyboard is live for arrows/actions; typing starts once the
  // user clicks into an entry cell. Falls back to the entry area only when
  // there are no saved rows to select.
  useEffect(() => {
    if (focusKey === undefined) return;
    const t = setTimeout(() => {
      if (rows.length > 0) {
        moveTo(rows.length - 1, 0);
      } else {
        const c = columns.findIndex((col) => col.entry);
        moveTo(draftStart, Math.max(0, c));
      }
      containerRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
    // Only when the tab (focusKey) changes — not on every data poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // Committed rows inside the selection, reported upward for the action bar.
  const lastEmittedIdsRef = useRef("");
  useEffect(() => {
    if (!onSelectedRowsChange) return;
    // Every rectangle, scattered ones included — the action bar acts on what
    // is lit up, and a Ctrl+clicked row that looks selected but is not sent
    // would quietly be left out of an approve or a delete.
    const seen = new Set<number>();
    const ids: (string | number)[] = [];
    for (const b of allRanges) {
      for (let r = b.r1; r <= Math.min(b.r2, draftStart - 1); r++) {
        if (seen.has(r)) continue;
        seen.add(r);
        const row = rows[r];
        if (row) ids.push(row.id);
      }
    }
    ids.sort((a, b) => String(a).localeCompare(String(b)));
    const key = ids.join(",");
    if (key === lastEmittedIdsRef.current) return;
    lastEmittedIdsRef.current = key;
    // Subscription-style notification; the parent's setState is in a callback.
     
    onSelectedRowsChange(ids);
  }, [allRanges, rows, draftStart, onSelectedRowsChange]);

  // ---- selection stats (the Excel status bar) ----

  const stats = useMemo(() => {
    if (!bounds) return null;
    let count = 0;
    let numCount = 0;
    let sum = 0;
    // Overlapping rectangles share cells; counting one twice would inflate the
    // sum the desk reads off the status bar to check a day's takings.
    const counted = new Set<string>();
    for (const b of allRanges) {
      for (let r = b.r1; r <= b.r2; r++) {
        // A whole-row range has no real right edge — clamp to this row's width
        // or the loop runs to MAX_SAFE_INTEGER and takes the tab with it.
        const lastC = Math.min(b.c2, colsFor(r).length - 1);
        for (let c = b.c1; c <= lastC; c++) {
          if (counted.has(`${r}:${c}`)) continue;
          counted.add(`${r}:${c}`);
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
    }
    return { count, numCount, sum, avg: numCount ? sum / numCount : 0 };
  }, [bounds, allRanges, cellValue, columns, colsFor]);

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
        suggestions: suggestionsAt(editing.r, editing.c),
        browse: editing.browse,
        onChange: (v) => setEditing((prev) => (prev ? { ...prev, value: v } : prev)),
        onKeyDown: (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commitEdit("none");
            onCommit();
          } else if (e.key === "Enter") {
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
        onQuery: suggestionQuery?.(editing.r, editing.c),
        onPick: commitWith,
        onAction: (value, typed) => {
          const { r, c } = editing;
          cancelEdit();
          onSuggestionAction?.({
            draftIndex: r >= draftStart ? r - draftStart : null,
            rowIndex: r,
            colIndex: c,
            value,
            typed,
          });
        },
      }
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* One focus wrapper over both scroll regions, so arrows/clipboard work
          the same whether the selection sits in saved rows or entry rows. */}
      <div
        ref={containerRef}
        data-sheet-grid=""
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onCopy={handleCopy}
        onCut={(e) => {
          handleCopy(e);
          if (!readOnly) clearDraftRange();
        }}
        onPaste={handlePaste}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
      <div
        ref={mainScrollRef}
        onScroll={(e) => {
          // Keep the entry dock's columns under the header's as either pans.
          const el = entryScrollRef.current;
          if (el && el.scrollLeft !== e.currentTarget.scrollLeft) {
            el.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        className="min-h-0 flex-1 overflow-auto"
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
            <LabelHeaderRow columns={columns} offset="top-5" />
          </thead>
          <tbody>
            {hiddenAbove > 0 && (
              <tr ref={topSentinelRef} className="h-7">
                <td
                  colSpan={nCols + 2}
                  className="select-none border-b border-border bg-muted/40 px-2 text-center text-[11px] text-muted-foreground"
                >
                  Loading earlier rows… ({hiddenAbove.toLocaleString()} above)
                </td>
              </tr>
            )}
            {visibleRows.map((row, i) => {
              const r = hiddenAbove + i;
              return (
              <GridRow
                key={row.id}
                rIdx={r}
                gutter={String(r + 1)}
                marker={null}
                cells={row.cells}
                columns={columns}
                isDraft={false}
                firstDraft={false}
                showPlaceholder={false}
                sel={
                  spansByRow.has(r)
                    ? {
                        spans: spansByRow.get(r)!,
                        anchorC: sel && sel.r === r ? sel.c : -1,
                      }
                    : null
                }
                editing={editing && editing.r === r ? editing.c : -1}
                editorProps={editing && editing.r === r ? editorProps : null}
                dropdownCols={dropdownColsByRow.get(r) ?? ""}
                onCellMouseDown={onCellMouseDown}
                onCellMouseEnter={onCellMouseEnter}
                onCellDoubleClick={onCellDoubleClick}
                onDropdownOpen={openDropdown}
              />
              );
            })}
            {(hasMore || loadingMore) && !hiddenAbove && (
              <tr ref={bottomSentinelRef} className="h-7">
                <td
                  colSpan={nCols + 2}
                  className="select-none border-b border-border bg-muted/40 px-2 text-center text-[11px] text-muted-foreground"
                >
                  {loadingMore ? "Loading more…" : "Scroll for more"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* NEW ENTRIES — docked below the rows, always visible, so "where do I
          type" answers itself. Same columns, x-scroll synced with the rows. */}
      {!readOnly && (
        <div className="relative shrink-0 border-t-2 border-emerald-600 dark:border-emerald-500">
          {/* The divider — drag to trade rows between the saved list and the
              dock, double-click to go back to the default split. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the entry area"
            title="Drag to resize · double-click to reset"
            onPointerDown={onDividerPointerDown}
            onDoubleClick={resetDock}
            className="group absolute -top-1.5 left-0 right-0 z-20 h-3 cursor-row-resize touch-none"
          >
            <div className="mx-auto mt-1 h-1 w-10 rounded-full bg-emerald-600/40 transition-colors group-hover:bg-emerald-600 dark:bg-emerald-400/40 dark:group-hover:bg-emerald-400" />
          </div>
          <div className="flex items-center gap-2 border-b border-border bg-emerald-600/10 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-300">
            <span className="font-bold">NEW ENTRIES</span>
            <span className="font-normal text-emerald-800/80 dark:text-emerald-300/80">
              type or paste here · Enter/Tab move · Enter on a ▾ cell opens its list · Ctrl/⌘+S saves the ✓ rows
            </span>
          </div>
          <div
            ref={entryScrollRef}
            onScroll={(e) => {
              const el = mainScrollRef.current;
              if (el && el.scrollLeft !== e.currentTarget.scrollLeft) {
                el.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
            style={
              dockHeight === null
                ? { maxHeight: DOCK_DEFAULT_MAX }
                : { height: dockHeight, maxHeight: "none" }
            }
            className="overflow-auto"
          >
            <table className="w-full table-fixed border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: 44 }} />
            {entryColumns.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
            {/* Unsized filler column — takes whatever width is left. */}
            <col />
          </colgroup>
              <thead>
                <LabelHeaderRow columns={entryColumns} offset="top-0" />
              </thead>
              <tbody>
                {(() => {
                  // The one row that carries the placeholder template: the first
                  // entry row that still has an empty entry field. It stays there
                  // — hinting the blanks — until every field is filled, then the
                  // hint moves to the next row.
                  const placeholderIndex = drafts.findIndex((d) =>
                    entryColumns.some((col, c) => col.entry && !(d[c] ?? "").trim()),
                  );
                  return drafts.map((draft, i) => {
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
                      columns={entryColumns}
                      isDraft
                      firstDraft={false}
                      showPlaceholder={i === placeholderIndex}
                      sel={
                        spansByRow.has(r)
                          ? {
                              spans: spansByRow.get(r)!,
                              anchorC: sel && sel.r === r ? sel.c : -1,
                            }
                          : null
                      }
                      editing={editing && editing.r === r ? editing.c : -1}
                      editorProps={editing && editing.r === r ? editorProps : null}
                      dropdownCols={dropdownColsByRow.get(r) ?? ""}
                      onCellMouseDown={onCellMouseDown}
                      onCellMouseEnter={onCellMouseEnter}
                      onCellDoubleClick={onCellDoubleClick}
                      onDropdownOpen={openDropdown}
                    />
                  );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>
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
            "Add rows in the NEW ENTRIES panel · select saved rows for actions · paste straight from Excel · Ctrl/⌘+S saves ready rows"
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

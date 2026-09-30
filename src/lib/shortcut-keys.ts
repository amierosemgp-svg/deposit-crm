/**
 * Where the CRM's own shortcuts meet Google Sheets'.
 *
 * The spreadsheet grid takes Google Sheets' keys (see sheet-grid.tsx). Where
 * the two disagreed, management settled each one:
 *
 *   ⌘P / ⌘B / ⌘I          stay the CRM's — approve/pull, complete/paid, retry.
 *                         The grid has no print layout, bold or italic.
 *   ⌘A / ⌘↵ / ⌘K          Sheets' — select all, fill range, insert link. The
 *   ⇧⌘↑↓ / ⇧⌘←→           CRM actions that were on them moved to new keys,
 *                         below. ⌘K and the ⇧⌘ arrows still do the CRM thing
 *                         outside the grid, where Sheets has no claim to them.
 *
 * ACTION_KEYS is one table, read by the page handlers, the chips on the
 * action-bar buttons and the shortcut manual; changing a key here changes it
 * everywhere. Every chord rides ⌘ on a Mac and Ctrl elsewhere. Before picking
 * a new one, check it against the Google Sheets groups in the shortcut manual,
 * and stay off ⌘C/V/X (clipboard), ⌘T/W/N (the browser never passes them on)
 * and ⌘M/⌘H/⌘Q (macOS takes them first).
 */

export type Chord = {
  /** `KeyboardEvent.key`, lower-case ("p", "enter", "arrowdown"). */
  key: string;
  shift?: boolean;
  alt?: boolean;
};

export type CrmAction =
  /** Open the selected player's details (Transactions and Players). */
  | "viewPlayer"
  /** Assign to me / Unassign. */
  | "assign"
  /** Approve a deposit · Pull credits on a withdrawal. */
  | "advance"
  /** Complete a deposit · Mark a withdrawal paid. */
  | "finish"
  /** Retry a failed deposit / transfer. */
  | "retry"
  /** Focus the header's player search. */
  | "searchPlayers"
  /** Next / previous page in the side menu. */
  | "nextPage"
  | "prevPage";

export const ACTION_KEYS: Record<CrmAction, Chord | null> = {
  viewPlayer: { key: "l" }, //                   was ⌘↵ (Sheets: fill range) — L for look up
  assign: { key: "j" }, //                       was ⌘A (Sheets: select all)
  advance: { key: "p" },
  finish: { key: "b" },
  retry: { key: "i" },
  searchPlayers: { key: "e" }, //                was ⌘K (Sheets: insert link) — the browser's own search key
  nextPage: { key: "arrowdown", alt: true }, //  was ⇧⌘↓ (Sheets: extend the selection)
  prevPage: { key: "arrowup", alt: true }, //    was ⇧⌘↑
};

const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/** Does this keydown fire the action? ⌘ on a Mac, Ctrl elsewhere — never both. */
export function matchesAction(e: KeyboardEvent, action: CrmAction): boolean {
  const chord = ACTION_KEYS[action];
  if (!chord) return false;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const wrongMod = IS_MAC ? e.ctrlKey : e.metaKey;
  return (
    mod &&
    !wrongMod &&
    e.shiftKey === !!chord.shift &&
    e.altKey === !!chord.alt &&
    e.key.toLowerCase() === chord.key
  );
}

/** Focus is inside the spreadsheet grid, where Google Sheets' keys win. */
export function inSheetGrid(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-sheet-grid]") !== null;
}

/**
 * Which way a Shift+⌘/Ctrl chord steps through worksheet tabs: +1, -1 or 0.
 * The caller has already checked the modifiers.
 *
 * PgUp/PgDn is Google Sheets' own key for it and works everywhere. ←/→ was
 * the CRM's first choice and still works outside the grid; inside it, Sheets
 * reads it as "extend the selection to the edge", so it is left to the grid.
 */
export function sheetTabStep(e: KeyboardEvent, target: EventTarget | null): -1 | 0 | 1 {
  if (e.key === "PageDown") return 1;
  if (e.key === "PageUp") return -1;
  if (inSheetGrid(target)) return 0;
  if (e.key === "ArrowRight") return 1;
  if (e.key === "ArrowLeft") return -1;
  return 0;
}

const KEY_LABELS: Record<string, string> = {
  enter: "↵",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

function keyLabel(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  return key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
}

/** The chord as separate keys, for the manual's <kbd> row. Empty when unbound. */
export function actionKeys(action: CrmAction): string[] {
  const chord = ACTION_KEYS[action];
  if (!chord) return [];
  return [
    ...(chord.shift ? ["Shift"] : []),
    IS_MAC ? "⌘" : "Ctrl",
    ...(chord.alt ? [IS_MAC ? "⌥" : "Alt"] : []),
    keyLabel(chord.key),
  ];
}

/** The chord as one chip label ("Ctrl+P", "⇧⌘P"), or null when unbound. */
export function actionLabel(action: CrmAction): string | null {
  const chord = ACTION_KEYS[action];
  if (!chord) return null;
  if (IS_MAC) {
    return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}⌘${keyLabel(chord.key)}`;
  }
  return `Ctrl+${chord.alt ? "Alt+" : ""}${chord.shift ? "Shift+" : ""}${keyLabel(chord.key)}`;
}

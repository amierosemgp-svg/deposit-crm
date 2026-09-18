"use client";

/**
 * Jump to the page's own search box: ⌘F (Ctrl+F), or "/" when your hands
 * aren't already somewhere that wants the key.
 *
 * ⌘K is the global player search and leaves the page; this is the filter box
 * belonging to the screen you're already on — Deposits, Withdrawals, Players,
 * the sheet, the log. Each page marks its input `data-page-search` and gets
 * both shortcuts for free; nothing to wire up per page.
 *
 * Two bindings, because one isn't enough:
 *
 * "/" is the convention (GitHub, Slack) and reads well on the list pages, but
 * the spreadsheet grid claims every printable key to start a cell edit — on
 * Transactions and Players the grid holds focus almost all the time, so a
 * bare "/" there lands in a cell instead of the search box. It has to keep
 * doing that: "/" is a character someone may want to type.
 *
 * So ⌘F is the one that always works. The grid passes every ⌘/Ctrl chord
 * straight through (see handleKeyDown's `if (mod) return`), so this can take
 * it from anywhere, mid-cell-edit included. It replaces the browser's find
 * bar deliberately: these lists are filtered on the server and paginated, so
 * searching the rendered page finds less than the box does.
 */

import { useEffect } from "react";

const SEARCH_SELECTOR = "input[data-page-search]";

const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/** Typing somewhere that wants a bare "/" — the grid included. */
function isTyping(el: HTMLElement | null): boolean {
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable ||
    // The spreadsheet swallows printable keys to start a cell edit, so a "/"
    // typed with the grid focused belongs to the cell. ⌘F still gets through.
    el.closest("[data-sheet-grid]") !== null
  );
}

/** ⌘F on a Mac, Ctrl+F elsewhere — never the other one. */
function isFindChord(e: KeyboardEvent): boolean {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const wrongMod = IS_MAC ? e.ctrlKey : e.metaKey;
  if (!mod || wrongMod || e.altKey || e.shiftKey) return false;
  return e.key === "f" || e.key === "F";
}

export function PageSearchShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;

      // Esc in the search box hands focus back to the page, so the next
      // keystroke reaches the grid/list instead of the filter.
      if (e.key === "Escape" && target?.matches?.(SEARCH_SELECTOR)) {
        target.blur();
        return;
      }

      const chord = isFindChord(e);
      // The chord works wherever you are; the bare key defers to whatever is
      // already taking your keystrokes.
      if (!chord) {
        if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if (isTyping(target)) return;
      }

      const input = document.querySelector<HTMLInputElement>(SEARCH_SELECTOR);
      if (!input) return; // this page has no search box — leave ⌘F to Chrome
      e.preventDefault();
      e.stopPropagation();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return null;
}

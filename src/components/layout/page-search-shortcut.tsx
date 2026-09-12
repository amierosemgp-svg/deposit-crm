"use client";

/**
 * "/" focuses the page's own search box, wherever you are.
 *
 * ⌘K is the global player search (it leaves the page); this is the filter box
 * that belongs to the screen you're already on — Deposits, Withdrawals,
 * Players, the sheet, the log. Each page marks its input `data-page-search`
 * and gets the shortcut for free; nothing to wire up per page.
 *
 * "/" is the convention (GitHub, Slack) and is otherwise unused here — "?"
 * is Shift+/, so the shortcut manual still opens. Esc gives focus back.
 */

import { useEffect } from "react";

const SEARCH_SELECTOR = "input[data-page-search]";

/** Typing somewhere real — never steal the key from a field or the sheet. */
function isTyping(el: HTMLElement | null): boolean {
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable ||
    // The spreadsheet swallows printable keys to start a cell edit, so a "/"
    // typed with the grid focused belongs to the cell, not to the search box.
    el.closest("[data-sheet-grid]") !== null
  );
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

      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isTyping(target)) return;

      const input = document.querySelector<HTMLInputElement>(SEARCH_SELECTOR);
      if (!input) return; // this page has no search box
      e.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return null;
}

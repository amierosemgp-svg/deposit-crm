"use client";

/**
 * Keyboard shortcut manual — every binding in the CRM, grouped by where it
 * works, opened from the header (a keyboard icon) or with ? / Cmd-/.
 *
 * Keys are written platform-aware: ⌘ on macOS, Ctrl elsewhere, so the sheet
 * that a Mac user reads matches the keys their machine actually sends.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Keyboard } from "lucide-react";

const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";
const ALT = IS_MAC ? "⌥" : "Alt";

/** A shortcut: its keys (each rendered as a <kbd>) and what it does. */
type Shortcut = { keys: string[]; label: string };
type Group = { title: string; hint?: string; items: Shortcut[] };

const GROUPS: Group[] = [
  {
    title: "Move around the sheet",
    hint: "Transactions grid",
    items: [
      { keys: ["↑", "↓", "←", "→"], label: "Move one cell" },
      { keys: ["Tab"], label: "Next cell · Shift+Tab back" },
      { keys: ["Enter"], label: "Down a row · after a Tab run, back to its first column · on a ▾ cell, opens its list" },
      { keys: ["Shift", "↑↓←→"], label: "Extend the selection" },
      { keys: ["Home"], label: "First column · Shift+Home extends" },
      { keys: ["End"], label: "Last column · Shift+End extends" },
      { keys: ["PgUp"], label: "Jump up 20 rows" },
      { keys: ["PgDn"], label: "Jump down 20 rows" },
      { keys: [MOD, "A"], label: "Select the whole sheet" },
    ],
  },
  {
    title: "Enter & edit",
    hint: "New entry rows",
    items: [
      { keys: ["type"], label: "Start editing — replaces the cell" },
      { keys: ["F2"], label: "Edit in place — keeps the value" },
      { keys: ["double-click"], label: "Edit a cell" },
      { keys: ["Esc"], label: "Cancel the edit / close the dropdown" },
      { keys: ["Enter"], label: "Commit & move down" },
      { keys: ["Tab"], label: "Commit & move right" },
    ],
  },
  {
    title: "Suggestion dropdown",
    hint: "Member, product, bank, bonus…",
    items: [
      { keys: ["Enter"], label: "Open the list on a ▾ cell · Alt+↓ too, and while editing" },
      { keys: ["↑", "↓"], label: "Move through the suggestions" },
      { keys: ["Enter"], label: "Accept — stays on the cell" },
      { keys: ["Tab"], label: "Accept & move to the next cell" },
      { keys: ["Esc"], label: "Close the list (Esc again cancels the edit)" },
    ],
  },
  {
    title: "Clipboard & clearing",
    hint: "Works with Excel",
    items: [
      { keys: [MOD, "C"], label: "Copy the selection (TSV)" },
      { keys: [MOD, "V"], label: "Paste a block into the entry rows" },
      { keys: [MOD, "X"], label: "Cut draft cells" },
      { keys: ["Delete"], label: "Clear the selected draft cells" },
    ],
  },
  {
    title: "Save & switch sheets",
    hint: "Transactions & Players",
    items: [
      { keys: [MOD, "S"], label: "Save the ready (✓) entry rows" },
      { keys: ["Shift", MOD, "→"], label: "Next worksheet tab (Deposit… / Players / Leads)" },
      { keys: ["Shift", MOD, "←"], label: "Previous worksheet tab" },
    ],
  },
  {
    title: "Act on selected rows",
    hint: "Select saved rows first",
    items: [
      { keys: [MOD, "↵"], label: "Open the player's details" },
      { keys: [MOD, "A"], label: "Assign to me / Unassign" },
      { keys: [MOD, "P"], label: "Approve (deposit) · Pull credits (withdrawal)" },
      { keys: [MOD, "C"], label: "Complete a deposit" },
      { keys: [MOD, "B"], label: "Mark a withdrawal paid" },
      { keys: [MOD, "I"], label: "Retry a failed deposit / transfer" },
      { keys: [MOD, "D"], label: "Delete an expense" },
      { keys: ["Esc"], label: "Clear the selection" },
    ],
  },
  {
    title: "Player details",
    hint: "While the profile modal is open",
    items: [{ keys: ["↑", "↓"], label: "Move between the profile sections" }],
  },
  {
    title: "Anywhere",
    items: [
      { keys: ["Shift", MOD, "↓"], label: "Next side-menu page" },
      { keys: ["Shift", MOD, "↑"], label: "Previous side-menu page" },
      { keys: [MOD, "K"], label: "Search players" },
      { keys: ["?"], label: "Open this shortcut manual" },
    ],
  },
  {
    title: "Emergency",
    hint: "Admins",
    items: [
      { keys: ["Ctrl", ALT, "Delete"], label: "Emergency kill switch" },
    ],
  },
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex flex-shrink-0 items-center gap-1">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="inline-flex min-w-[1.6rem] items-center justify-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground shadow-[0_1px_0_var(--border)]"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function ShortcutsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] sm:max-w-4xl overflow-hidden p-0">
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-3.5">
          <Keyboard className="h-4 w-4 text-muted-foreground" />
          <DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {IS_MAC ? "⌘ = Command" : "Ctrl"} · press{" "}
            <kbd className="rounded border border-border bg-muted px-1 text-[10px] font-semibold">
              Esc
            </kbd>{" "}
            to close
          </span>
        </div>
        <div className="max-h-[calc(85vh-56px)] overflow-y-auto px-5 py-4">
          <div className="space-y-5">
            {GROUPS.map((g) => (
              <section key={g.title}>
                <div className="mb-2 flex items-baseline gap-2 border-b border-border/60 pb-1">
                  <h3 className="text-[13px] font-semibold">{g.title}</h3>
                  {g.hint && (
                    <span className="text-[11px] text-muted-foreground">{g.hint}</span>
                  )}
                </div>
                <ul>
                  {g.items.map((s, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-6 rounded-md px-2 py-1.5 text-[13px] odd:bg-muted/40"
                    >
                      <span className="text-muted-foreground">{s.label}</span>
                      <Keys keys={s.keys} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Header button + the ? / Cmd-/ global opener. Mount once in the top nav. */
export function ShortcutsButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      // "?" (Shift+/) or Cmd/Ctrl-/ opens the manual from anywhere.
      const opener =
        (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) ||
        ((e.metaKey || e.ctrlKey) && e.key === "/");
      if (opener) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Keyboard className="h-4 w-4" />
      </button>
      <ShortcutsModal open={open} onOpenChange={setOpen} />
    </>
  );
}

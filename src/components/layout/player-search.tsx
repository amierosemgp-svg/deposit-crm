"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { usePlayerProfile } from "@/components/player-name-link";
import { initialsOf, formatRM } from "@/lib/format";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { Search, X } from "lucide-react";

const MAX_RESULTS = 8;

/**
 * Global player lookup in the header — the thing CS reaches for when a player
 * messages them, from whatever page they happen to be on. Picking a result
 * opens the same profile modal the rest of the CRM uses, so nobody loses their
 * place navigating to the Players page and back.
 *
 * Searches the already-hydrated store rather than the API: every player in
 * scope is in memory, so results are instant — which matters when a production
 * round trip is about a second.
 */
export function PlayerSearch() {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const players = useStore((s) => s.players);
  const entityName = useStore((s) => s.entityName);
  const companyInScope = useStore((s) => s.companyInScope);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const { openPlayer } = usePlayerProfile();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return players
      .filter(
        (p) =>
          companyInScope(p.company_entity_id) &&
          (p.full_name.toLowerCase().includes(q) ||
            p.username.toLowerCase().includes(q) ||
            (p.telegram_username ?? "").toLowerCase().includes(q) ||
            (p.contact_number ?? "").toLowerCase().includes(q)),
      )
      .slice(0, MAX_RESULTS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, query, selectedCompanyId, selectedLeaderId]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // ⌘K / Ctrl-K from anywhere — CS looks players up constantly.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function pick(playerId: number) {
    openPlayer(playerId);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[Math.min(highlight, results.length - 1)].player_id);
    }
  }

  const showPanel = open && query.trim().length > 0;

  return (
    <div ref={rootRef} className="relative w-[260px]">
      <Search className="absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search players…"
        aria-label="Search players"
        // Borderless to match the scope pickers beside it — the caret is the
        // focus cue, and the header's divider lines do the separating.
        className="h-9 w-full border-none bg-transparent pl-6 pr-14 text-sm outline-none"
      />
      {query ? (
        <button
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          // Same chip treatment as the ⌘K badge it replaces, so the right end
          // of the borderless field doesn't change shape as you type.
          className="absolute right-2 top-1/2 inline-flex -translate-y-1/2 cursor-pointer items-center rounded border bg-muted p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          ⌘K
        </kbd>
      )}

      {showPanel && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-muted-foreground">
              No player matches “{query.trim()}”.
            </p>
          ) : (
            <ul className="max-h-[340px] overflow-y-auto py-1">
              {results.map((p, i) => (
                <li key={p.player_id}>
                  <button
                    onClick={() => pick(p.player_id)}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left",
                      i === highlight && "bg-muted",
                    )}
                  >
                    <Avatar className="h-7 w-7 shrink-0">
                      <AvatarFallback className="text-[10px] font-semibold">
                        {initialsOf(p.full_name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">
                        {p.full_name}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        @{p.username} · {entityName(p.company_entity_id)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-[11px]">
                      <span className="block text-muted-foreground">
                        Deposits
                      </span>
                      <span className="block font-medium tabular-nums">
                        {formatRM(p.total_deposits)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

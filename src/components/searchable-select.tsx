"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A select with a type-to-filter box inside it.
 *
 * The plain Select is fine for four games, but the provider list keeps growing
 * and CS picks one on every pending deposit — scrolling a long list for each row
 * is the slow part of the job. Typing two letters beats scrolling.
 */
export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  emptyMessage = "Nothing to pick",
  searchPlaceholder = "Type to search…",
  disabled,
  className,
  align = "start",
}: {
  value: string | null;
  onValueChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  emptyMessage?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Viewport coordinates for the menu. It is portalled to the body because the
  // deposits table scrolls inside an overflow container, which would otherwise
  // clip the list to the table's edge.
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    above: boolean;
  } | null>(null);

  const MENU_MIN_WIDTH = 180;
  const MENU_MAX_HEIGHT = 260;

  function place() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, MENU_MIN_WIDTH);
    const spaceBelow = window.innerHeight - r.bottom;
    const above = spaceBelow < MENU_MAX_HEIGHT && r.top > spaceBelow;
    const left = align === "end" ? r.right - width : r.left;
    setPos({
      top: above ? r.top - 4 : r.bottom + 4,
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      width,
      above,
    });
  }

  function close() {
    setOpen(false);
    setQuery("");
    setPos(null);
  }

  // Close on outside click or Escape; follow the trigger while scrolling.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      // The menu is portalled out of this subtree, so check it separately.
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function reposition() {
      place();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Land the caret in the search box so you can just start typing.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  function pick(option: string) {
    onValueChange(option);
    close();
  }

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (open) return close();
          place();
          setOpen(true);
        }}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm outline-none",
          "cursor-pointer hover:border-ring/60 focus:border-ring focus:ring-2 focus:ring-ring/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {value ?? placeholder}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            width: pos.width,
            transform: pos.above ? "translateY(-100%)" : undefined,
          }}
          className="z-50 overflow-hidden rounded-md border bg-popover shadow-md"
        >
          <div className="flex items-center gap-2 border-b px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter takes the only remaining match — the common case after
                // typing two or three letters.
                if (e.key === "Enter" && filtered.length > 0) {
                  e.preventDefault();
                  pick(filtered[0]);
                }
              }}
              placeholder={searchPlaceholder}
              className="h-8 w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                {options.length === 0 ? emptyMessage : "No match"}
              </div>
            ) : (
              filtered.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => pick(option)}
                  className={cn(
                    "flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-muted",
                    option === value && "font-medium",
                  )}
                >
                  <span className="truncate">{option}</span>
                  {option === value && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { Activity, ChevronDown, Pause, Play, Radio } from "lucide-react";
import { cn } from "@/lib/utils";

type BotEvent = {
  event_id: number;
  bot_id: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  message: string | null;
  context: Record<string, unknown> | null;
  game_transfer_id: number | null;
  deposit_id: number | null;
  withdrawal_id: number | null;
  player_id: number | null;
  occurred_at: string;
};

const LEVEL_STYLE: Record<BotEvent["level"], string> = {
  debug: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  error: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
};

const MAX_ROWS = 300;
// Collapsed, the feed is only feeding a badge — no reason to poll as hard.
const POLL_OPEN_MS = 4000;
const POLL_CLOSED_MS = 15000;

/**
 * What the agent is doing, as it does it — docked bottom-left on every page.
 *
 * Lives in the CRM layout rather than on one page: the feed is what you want
 * open *while* working a queue, not something to navigate away to. Collapsed it
 * is a pill with an unread count; the badge turns red when any of those unread
 * events was a warning or error, so a problem is visible without opening it.
 */
export function BotLiveFeed() {
  const [events, setEvents] = useState<BotEvent[]>([]);
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [unreadBad, setUnreadBad] = useState(false);

  // The one piece of cross-tick state the loop needs; `open` is a dependency
  // of poll instead, so no ref juggling is required for it.
  const sinceId = useRef(0);
  // Two polls overlapping would both read the same sinceId and both prepend
  // the same batch. Cheaper to never let them overlap than to reconcile after.
  const inFlight = useRef(false);
  // Event ids already taken, so a duplicate can never reach the list.
  const seenIds = useRef<Set<number>>(new Set());

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    // Captured before sinceId moves: the first response backfills history,
    // which is not "new" and must not light up the unread badge.
    const isFirstLoad = sinceId.current === 0;
    try {
      const url = isFirstLoad
        ? "/api/bot-events?limit=100"
        : `/api/bot-events?since_id=${sinceId.current}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      setError(null);
      const fresh: BotEvent[] = data.events ?? [];
      if (!fresh.length) return;

      sinceId.current = Math.max(sinceId.current, data.latest_id ?? 0);

      // Belt and braces alongside the in-flight guard: event_id is unique, so
      // filtering against what we've already taken makes a repeated row
      // impossible however we got here. Done outside the state updater, which
      // React may defer or run twice.
      const incoming = fresh.filter((e) => !seenIds.current.has(e.event_id));
      if (!incoming.length) return;
      for (const e of incoming) seenIds.current.add(e.event_id);
      // sinceId only moves forward, so an id well behind it can never come
      // back — no need to remember every event of a long session.
      if (seenIds.current.size > MAX_ROWS * 4) {
        seenIds.current = new Set(
          [...seenIds.current].sort((a, b) => b - a).slice(0, MAX_ROWS),
        );
      }

      setEvents((prev) => [...incoming, ...prev].slice(0, MAX_ROWS));

      // Only badge what the panel isn't already showing.
      if (!open && !isFirstLoad) {
        setUnread((n) => Math.min(n + incoming.length, 99));
        if (incoming.some((e) => e.level === "warn" || e.level === "error")) {
          setUnreadBad(true);
        }
      }
    } catch {
      setError("Could not reach the feed");
    } finally {
      inFlight.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (paused) return;
    void poll();
    const id = setInterval(
      () => void poll(),
      open ? POLL_OPEN_MS : POLL_CLOSED_MS,
    );
    return () => clearInterval(id);
  }, [paused, open, poll]);

  // Escape closes the panel — it sits over the page, so it needs a way out
  // that doesn't require aiming at the chevron.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function expand() {
    setOpen(true);
    setUnread(0);
    setUnreadBad(false);
  }

  // ---- Collapsed: a pill ----
  if (!open) {
    return (
      <button
        onClick={expand}
        aria-label="Open agent live feed"
        className="fixed bottom-20 left-4 z-40 inline-flex cursor-pointer items-center gap-2 rounded-full border bg-popover/95 py-2 pl-3 pr-3.5 text-[12px] font-medium shadow-lg backdrop-blur transition-shadow hover:shadow-xl"
      >
        <span className="relative flex h-2 w-2">
          {!paused && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          )}
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              paused ? "bg-muted-foreground" : "bg-emerald-500",
            )}
          />
        </span>
        Agent Feed
        {unread > 0 && (
          <span
            className={cn(
              "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white",
              unreadBad ? "bg-red-600" : "bg-primary",
            )}
          >
            {unread > 98 ? "99+" : unread}
          </span>
        )}
      </button>
    );
  }

  // ---- Expanded: the panel ----
  return (
    <div className="fixed bottom-20 left-4 z-40 flex max-h-[min(70vh,520px)] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover shadow-2xl">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Radio
          className={cn(
            "h-4 w-4",
            paused ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400",
          )}
        />
        <span className="text-[13px] font-semibold">Agent Live Feed</span>
        {!paused && (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Resume" : "Pause"}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {paused ? (
              <>
                <Play className="h-3 w-3" /> Resume
              </>
            ) : (
              <>
                <Pause className="h-3 w-3" /> Pause
              </>
            )}
          </button>
          <button
            onClick={() => setOpen(false)}
            aria-label="Collapse agent live feed"
            className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error ? (
          <p className="px-3 py-6 text-center text-[12px] text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : events.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <Activity className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
            <p className="text-[12px] text-muted-foreground">
              Nothing yet. Events appear here as the agent posts them to{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                POST /api/bot/events
              </code>
              .
            </p>
          </div>
        ) : (
          <ul className="divide-y">
            {events.map((e) => {
              const ref =
                e.game_transfer_id != null
                  ? `transfer #${e.game_transfer_id}`
                  : e.deposit_id != null
                    ? `deposit #${e.deposit_id}`
                    : e.withdrawal_id != null
                      ? `withdrawal #${e.withdrawal_id}`
                      : e.player_id != null
                        ? `player #${e.player_id}`
                        : null;
              return (
                <li key={e.event_id} className="px-3 py-2 hover:bg-muted/40">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase",
                        LEVEL_STYLE[e.level],
                      )}
                    >
                      {e.level}
                    </span>
                    <span className="font-mono text-[11.5px] font-medium">
                      {e.event}
                    </span>
                    {ref && (
                      <span className="text-[10.5px] text-muted-foreground">
                        {ref}
                      </span>
                    )}
                    <span className="ml-auto whitespace-nowrap text-[10.5px] text-muted-foreground">
                      {formatDateTime(e.occurred_at)}
                    </span>
                  </div>
                  {e.message && (
                    <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                      {e.message}
                    </p>
                  )}
                  <p className="text-[9.5px] text-muted-foreground/70">
                    {e.bot_id}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

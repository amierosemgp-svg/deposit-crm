"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Pause, Play } from "lucide-react";

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
  debug: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  error: "border-red-500/30 bg-red-500/10 text-red-700",
};

const MAX_ROWS = 300;
const POLL_MS = 4000;

/**
 * What the bot is doing, as it does it.
 *
 * Tails /api/bot-events with `since_id` so each poll only carries what's new.
 * Pausing matters more than it looks: the feed is read when something is going
 * wrong, and a list that reorders under the cursor is unreadable at exactly
 * that moment.
 */
export function BotLiveFeed() {
  const [events, setEvents] = useState<BotEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref, not state: the poll loop reads it without re-subscribing each tick.
  const sinceId = useRef(0);

  const poll = useCallback(async () => {
    try {
      const url = sinceId.current
        ? `/api/bot-events?since_id=${sinceId.current}`
        : "/api/bot-events?limit=100";
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      setError(null);
      if (!data.events?.length) return;
      sinceId.current = Math.max(sinceId.current, data.latest_id ?? 0);
      setEvents((prev) => [...data.events, ...prev].slice(0, MAX_ROWS));
    } catch {
      setError("Could not reach the feed");
    }
  }, []);

  useEffect(() => {
    if (paused) return;
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [paused, poll]);

  return (
    <Card className="p-0 gap-0 overflow-hidden">
      <CardHeader className="flex-row items-center justify-between border-b">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity
            className={`h-4 w-4 ${paused ? "text-muted-foreground" : "text-emerald-600"}`}
          />
          Bot Live Feed
          {!paused && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          )}
        </CardTitle>
        <button
          onClick={() => setPaused((p) => !p)}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
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
      </CardHeader>

      <div className="max-h-[460px] overflow-y-auto">
        {error ? (
          <p className="px-4 py-6 text-center text-sm text-rose-600">{error}</p>
        ) : events.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            Nothing yet. Events appear here as the bot posts them to{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              POST /api/bot/events
            </code>
            .
          </p>
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
                <li key={e.event_id} className="px-4 py-2 hover:bg-muted/30">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase ${LEVEL_STYLE[e.level]}`}
                    >
                      {e.level}
                    </span>
                    <span className="font-mono text-[12px] font-medium">
                      {e.event}
                    </span>
                    {ref && (
                      <span className="text-[11px] text-muted-foreground">
                        {ref}
                      </span>
                    )}
                    <span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
                      {formatDateTime(e.occurred_at)}
                    </span>
                  </div>
                  {e.message && (
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {e.message}
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground/70">
                    {e.bot_id}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

"use client";

import { useMemo, useState } from "react";
import { Bot, RefreshCw, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/stat-tile";
import { useStore } from "@/lib/store";
import { formatDateTime, formatRelative, isBotOnline } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BotState } from "@/lib/types";

const STATE_STYLES: Record<BotState, string> = {
  working: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
  starting: "bg-sky-500/10 text-sky-700 border-sky-500/30",
  idle: "bg-zinc-500/10 text-zinc-700 border-zinc-500/30",
  stuck: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  error: "bg-red-500/10 text-red-700 border-red-500/30",
  maintenance: "bg-violet-500/10 text-violet-700 border-violet-500/30",
  stopped: "bg-zinc-500/10 text-zinc-600 border-zinc-500/30",
};

function StateBadge({ state }: { state: BotState }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize whitespace-nowrap",
        STATE_STYLES[state],
      )}
    >
      {state}
    </span>
  );
}

export default function BotHealthPage() {
  const botHealth = useStore((s) => s.botHealth);
  const refresh = useStore((s) => s.refresh);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...botHealth]
      .filter(
        (b) =>
          !q ||
          b.bot_id.toLowerCase().includes(q) ||
          (b.step ?? "").toLowerCase().includes(q) ||
          b.state.includes(q),
      )
      .sort((a, b) => a.bot_id.localeCompare(b.bot_id));
  }, [botHealth, query]);

  const online = botHealth.filter((b) => isBotOnline(b.last_heartbeat_at)).length;
  const offline = botHealth.length - online;
  // Bots that need attention: stuck/error AND currently online (a stale offline
  // bot's last state is less actionable than a live problem).
  const attention = botHealth.filter(
    (b) =>
      isBotOnline(b.last_heartbeat_at) &&
      (b.state === "stuck" || b.state === "error"),
  ).length;

  async function handleRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bot Health</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live status reported by each bot process · online = pinged in the
            last 90s
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
          className="cursor-pointer"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatTile
          title="Online"
          value={String(online)}
          sub={`${botHealth.length} bot${botHealth.length === 1 ? "" : "s"} total`}
          icon={Bot}
          tone="success"
          valueClassName={online > 0 ? "text-emerald-600" : undefined}
        />
        <StatTile
          title="Offline"
          value={String(offline)}
          sub="No ping in 90s"
          icon={Bot}
          tone={offline > 0 ? "danger" : "default"}
          valueClassName={offline > 0 ? "text-rose-600" : undefined}
        />
        <StatTile
          title="Needs attention"
          value={String(attention)}
          sub="Online but stuck / error"
          icon={Bot}
          tone={attention > 0 ? "warning" : "default"}
          valueClassName={attention > 0 ? "text-amber-600" : undefined}
        />
      </div>

      <Card className="p-3">
        <div className="relative max-w-xs">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search bot id, step, state…"
            className="h-8 pl-8"
          />
        </div>
      </Card>

      <Card className="p-0 gap-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium">Bot</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-left font-medium">State</th>
                <th className="px-3 py-2.5 text-left font-medium">Step</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Cycle</th>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Last heartbeat</th>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Last transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const online = isBotOnline(b.last_heartbeat_at);
                return (
                  <tr key={b.bot_id} className="border-t hover:bg-muted/30 align-top">
                    <td className="px-3 py-2.5">
                      <div className="font-mono text-[12px] font-medium">
                        {b.bot_id}
                      </div>
                      {b.error && (
                        <div className="mt-0.5 text-[11px] text-red-600 max-w-[240px]">
                          {b.error}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="relative flex h-2 w-2">
                          {online && (
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                          )}
                          <span
                            className={cn(
                              "relative inline-flex h-2 w-2 rounded-full",
                              online ? "bg-emerald-500" : "bg-red-500",
                            )}
                          />
                        </span>
                        <span
                          className={cn(
                            "text-[11px] font-medium",
                            online ? "text-emerald-700" : "text-red-600",
                          )}
                        >
                          {online ? "Online" : "Offline"}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <StateBadge state={b.state} />
                    </td>
                    <td className="px-3 py-2.5 text-[12px]">{b.step ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right text-[12px] tabular-nums">
                      {b.cycle ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] whitespace-nowrap">
                      {formatRelative(b.last_heartbeat_at)}
                      <div className="text-[10px] text-muted-foreground">
                        {formatDateTime(b.last_heartbeat_at)}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] whitespace-nowrap">
                      {b.last_transaction_at
                        ? formatRelative(b.last_transaction_at)
                        : "—"}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-12 text-center text-xs text-muted-foreground"
                  >
                    {botHealth.length === 0
                      ? "No bots have reported yet."
                      : "No bots match your search."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

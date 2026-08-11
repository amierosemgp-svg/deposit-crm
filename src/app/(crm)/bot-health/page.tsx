"use client";

import { useMemo, useState } from "react";
import { Banknote, Bot, Gamepad2, RefreshCw, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/stat-tile";
import { ListLoading } from "@/components/list-loading";
import { useStore } from "@/lib/store";
import { formatDateTime, formatRelative, isBotOnline } from "@/lib/format";
import { bankNamesFrom, botCategory } from "@/lib/bot-category";
import { cn } from "@/lib/utils";
import type { BotHealth, BotState } from "@/lib/types";

const STATE_STYLES: Record<BotState, string> = {
  working: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  starting: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30",
  idle: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
  stuck: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
  error: "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30",
  maintenance: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30",
  stopped: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

/**
 * `stale` = the bot stopped pinging, so this state is only the last thing it
 * managed to report. Rendering a days-old "Working" in full colour next to
 * "Offline" reads as a contradiction, and looks like the page is broken.
 */
function StateBadge({ state, stale }: { state: BotState; stale?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize whitespace-nowrap",
        stale
          ? "border-zinc-300 bg-zinc-100 dark:bg-zinc-950/40 text-zinc-500 dark:text-zinc-400"
          : STATE_STYLES[state],
      )}
    >
      {state}
    </span>
  );
}

function OnlinePip({ online }: { online: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
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
          online ? "text-emerald-700 dark:text-emerald-300" : "text-red-600 dark:text-red-400",
        )}
      >
        {online ? "Online" : "Offline"}
      </span>
    </span>
  );
}

/** One bot's full log entry, sized for a column rather than a wide table. */
function BotRow({ bot }: { bot: BotHealth }) {
  const online = isBotOnline(bot.last_heartbeat_at);
  return (
    <li className="px-4 py-2.5 hover:bg-muted/30">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium">
          {bot.bot_id}
        </span>
        <OnlinePip online={online} />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {!online && (
          <span className="text-[10px] text-muted-foreground">last known</span>
        )}
        <StateBadge state={bot.state} stale={!online} />
        <span className="text-[11px] text-muted-foreground">
          {bot.step ?? "—"}
        </span>
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        {bot.cycle != null && <span>cycle {bot.cycle}</span>}
        <span
          title={formatDateTime(bot.last_heartbeat_at)}
          className={cn(!online && "font-medium text-red-600 dark:text-red-400")}
        >
          {online ? "ping" : "last seen"}{" "}
          {formatRelative(bot.last_heartbeat_at)}
        </span>
        <span>
          txn{" "}
          {bot.last_transaction_at
            ? formatRelative(bot.last_transaction_at)
            : "—"}
        </span>
      </div>

      {bot.error && (
        <p className="mt-1 text-[11px] leading-snug text-red-600 dark:text-red-400">{bot.error}</p>
      )}
    </li>
  );
}

/** One column of bots — same shell for banks and kiosks. */
function BotColumn({
  title,
  icon: Icon,
  bots,
  hydrated,
  emptyLabel,
}: {
  title: string;
  icon: typeof Banknote;
  bots: BotHealth[];
  hydrated: boolean;
  emptyLabel: string;
}) {
  const online = bots.filter((b) => isBotOnline(b.last_heartbeat_at)).length;
  return (
    <Card className="flex flex-col p-0 gap-0 overflow-hidden">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{title}</span>
        <span className="ml-auto text-[12px] tabular-nums">
          <span
            className={cn(
              "font-medium",
              bots.length === 0
                ? "text-muted-foreground"
                : online === bots.length
                  ? "text-emerald-600 dark:text-emerald-400"
                  : online === 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-amber-600 dark:text-amber-400",
            )}
          >
            {online}
          </span>
          <span className="text-muted-foreground"> / {bots.length} online</span>
        </span>
      </div>
      <div className="max-h-[560px] flex-1 overflow-y-auto">
        {bots.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">
            {!hydrated ? (
              <ListLoading className="py-0" label="Loading bots…" />
            ) : (
              emptyLabel
            )}
          </div>
        ) : (
          <ul className="divide-y">
            {bots.map((b) => (
              <BotRow key={b.bot_id} bot={b} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export default function BotHealthPage() {
  const botHealth = useStore((s) => s.botHealth);
  const bankAccounts = useStore((s) => s.bankAccounts);
  const banksFn = useStore((s) => s.banks);
  const hydrated = useStore((s) => s.hydrated);
  const refresh = useStore((s) => s.refresh);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const bankNames = useMemo(
    () => bankNamesFrom(bankAccounts, banksFn()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bankAccounts],
  );

  const { bankBots, kioskBots } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = botHealth
      .filter(
        (b) =>
          !q ||
          b.bot_id.toLowerCase().includes(q) ||
          (b.step ?? "").toLowerCase().includes(q) ||
          b.state.includes(q),
      )
      .sort((a, b) => {
        // Anything wrong first — that's what this page is for. Then offline,
        // then alphabetical so the list is stable between refreshes.
        const bad = (x: typeof a) =>
          x.state === "stuck" || x.state === "error" ? 0 : 1;
        const d = bad(a) - bad(b);
        if (d !== 0) return d;
        const on =
          Number(isBotOnline(a.last_heartbeat_at)) -
          Number(isBotOnline(b.last_heartbeat_at));
        if (on !== 0) return on;
        return a.bot_id.localeCompare(b.bot_id);
      });

    return {
      bankBots: matched.filter((b) => botCategory(b.bot_id, bankNames) === "bank"),
      kioskBots: matched.filter(
        (b) => botCategory(b.bot_id, bankNames) === "kiosk",
      ),
    };
  }, [botHealth, query, bankNames]);

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
            Online = pinged within 90s. A bot that stopped pinging shows its{" "}
            <span className="font-medium">last known</span> state — that state
            is however old the last ping is, not current.
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
          valueClassName={online > 0 ? "text-emerald-600 dark:text-emerald-400" : undefined}
        />
        <StatTile
          title="Offline"
          value={String(offline)}
          sub="No ping in 90s"
          icon={Bot}
          tone={offline > 0 ? "danger" : "default"}
          valueClassName={offline > 0 ? "text-rose-600 dark:text-rose-400" : undefined}
        />
        <StatTile
          title="Needs attention"
          value={String(attention)}
          sub="Online but stuck / error"
          icon={Bot}
          tone={attention > 0 ? "warning" : "default"}
          valueClassName={attention > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
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

      {/* Every bot, split by what it drives. A bank bot going down stops
          deposits being detected; a kiosk bot going down stops top-ups. They're
          different problems for different people, so they don't share a list. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BotColumn
          title="Bank Bots"
          icon={Banknote}
          bots={bankBots}
          hydrated={hydrated}
          emptyLabel={
            query ? "No bank bots match your search." : "No bank bots reporting."
          }
        />
        <BotColumn
          title="Kiosk Bots"
          icon={Gamepad2}
          bots={kioskBots}
          hydrated={hydrated}
          emptyLabel={
            query
              ? "No kiosk bots match your search."
              : "No kiosk bots reporting."
          }
        />
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { Banknote, Bot, Gamepad2, RefreshCw, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/stat-tile";
import { ListLoading } from "@/components/list-loading";
import { useStore } from "@/lib/store";
import {
  formatDateTime,
  formatRM,
  formatRelative,
  isBotOnline,
  isOnline,
} from "@/lib/format";
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

/**
 * Online pip + label. Bots use a 90s window, bank logins and kiosks a 5-minute
 * one — the caller decides which, this just renders the verdict.
 */
function OnlinePip({ online }: { online: boolean }) {
  return (
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
  );
}

/** One connectivity list — same shell for bank logins and kiosks. */
function ConnectivityCard({
  title,
  icon: Icon,
  online,
  total,
  emptyLabel,
  hydrated,
  children,
}: {
  title: string;
  icon: typeof Banknote;
  online: number;
  total: number;
  emptyLabel: string;
  hydrated: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col p-0 gap-0 overflow-hidden">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{title}</span>
        <span className="ml-auto text-[12px] tabular-nums">
          <span
            className={cn(
              "font-medium",
              total === 0
                ? "text-muted-foreground"
                : online === total
                  ? "text-emerald-600"
                  : online === 0
                    ? "text-rose-600"
                    : "text-amber-600",
            )}
          >
            {online}
          </span>
          <span className="text-muted-foreground"> / {total} online</span>
        </span>
      </div>
      <div className="max-h-[420px] flex-1 overflow-y-auto">
        {total === 0 ? (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">
            {!hydrated ? (
              <ListLoading className="py-0" label="Loading…" />
            ) : (
              emptyLabel
            )}
          </div>
        ) : (
          <ul className="divide-y">{children}</ul>
        )}
      </div>
    </Card>
  );
}

export default function BotHealthPage() {
  const botHealth = useStore((s) => s.botHealth);
  const bankAccounts = useStore((s) => s.bankAccounts);
  const boAccounts = useStore((s) => s.boAccounts);
  const companyInScope = useStore((s) => s.companyInScope);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const hydrated = useStore((s) => s.hydrated);
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

  // Bank logins and kiosks the bot signs into. Same search box as the bots
  // table — one query across everything on the page.
  const banks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bankAccounts
      .filter((a) => companyInScope(a.entity_id))
      .filter(
        (a) =>
          !q ||
          a.bank_name.toLowerCase().includes(q) ||
          (a.label ?? "").toLowerCase().includes(q) ||
          a.account_number.toLowerCase().includes(q) ||
          (a.login_id ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => {
        // Offline first — the whole point of this page is spotting what's down.
        const d = Number(isOnline(a.last_heartbeat_at)) -
          Number(isOnline(b.last_heartbeat_at));
        if (d !== 0) return d;
        return a.bank_name.localeCompare(b.bank_name);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bankAccounts, query, selectedCompanyId, selectedLeaderId]);

  const kiosks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return boAccounts
      .filter((k) => companyInScope(k.company_entity_id))
      .filter(
        (k) =>
          !q ||
          k.game_name.toLowerCase().includes(q) ||
          k.bo_username.toLowerCase().includes(q) ||
          (k.bo_label ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const d = Number(isOnline(a.last_heartbeat_at)) -
          Number(isOnline(b.last_heartbeat_at));
        if (d !== 0) return d;
        return a.game_name.localeCompare(b.game_name);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boAccounts, query, selectedCompanyId, selectedLeaderId]);

  const banksOnline = banks.filter((a) => isOnline(a.last_heartbeat_at)).length;
  const kiosksOnline = kiosks.filter((k) => isOnline(k.last_heartbeat_at)).length;

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
            Bot processes ping every 90s; the bank logins and kiosks they sign
            into ping every 5 minutes
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
            placeholder="Search bots, banks, kiosks…"
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
                      <OnlinePip online={online} />
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
                    {!hydrated ? (
                      <ListLoading className="py-0" label="Loading bots…" />
                    ) : botHealth.length === 0 ? (
                      "No bots have reported yet."
                    ) : (
                      "No bots match your search."
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Bank logins and kiosks side by side — both are things the bot signs
          into, and when a top-up fails the question is which one is down. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ConnectivityCard
          title="Bank Accounts"
          icon={Banknote}
          online={banksOnline}
          total={banks.length}
          hydrated={hydrated}
          emptyLabel={
            query ? "No banks match your search." : "No bank accounts yet."
          }
        >
          {banks.map((a) => (
            <li key={a.account_id} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  {a.bank_name}
                  {a.label && (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {a.label}
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {a.account_number}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <OnlinePip online={isOnline(a.last_heartbeat_at)} />
                <div className="text-[10px] text-muted-foreground">
                  {a.last_heartbeat_at
                    ? formatRelative(a.last_heartbeat_at)
                    : "never pinged"}
                </div>
              </div>
            </li>
          ))}
        </ConnectivityCard>

        <ConnectivityCard
          title="Kiosks"
          icon={Gamepad2}
          online={kiosksOnline}
          total={kiosks.length}
          hydrated={hydrated}
          emptyLabel={
            query ? "No kiosks match your search." : "No kiosk accounts yet."
          }
        >
          {kiosks.map((k) => (
            <li
              key={k.bo_account_id}
              className="flex items-start gap-3 px-4 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  {k.game_name}
                  {k.bo_label && (
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {k.bo_label}
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {k.bo_username}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <OnlinePip online={isOnline(k.last_heartbeat_at)} />
                <div className="text-[10px] text-muted-foreground">
                  {formatRM(k.current_credit)}
                </div>
              </div>
            </li>
          ))}
        </ConnectivityCard>
      </div>
    </div>
  );
}

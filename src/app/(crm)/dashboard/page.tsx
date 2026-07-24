"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import Link from "next/link";
import { formatRM, formatDateTime, isBotOnline } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/stat-tile";
import { ListLoading } from "@/components/list-loading";
import { StatusBadge } from "@/components/status-badge";
import { PlayerNameLink } from "@/components/player-name-link";
import { cn } from "@/lib/utils";
import {
  Wallet,
  Clock,
  Banknote,
  Users,
  TrendingUp,
  Coins,
  Loader2,
  Bot,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function inRange(iso: string | null | undefined, from: string, to: string) {
  if (!iso) return false;
  const day = iso.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

// online/total → colour: neutral when nothing configured, green all-up, red all-down, amber partial.
function statusColor(online: number, total: number) {
  if (total === 0) return "text-muted-foreground";
  if (online === total) return "text-emerald-600";
  if (online === 0) return "text-red-600";
  return "text-amber-600";
}

function EmptyRow({
  colSpan,
  hydrated,
  message,
}: {
  colSpan: number;
  hydrated: boolean;
  message: string;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-4 py-8 text-center text-xs text-muted-foreground"
      >
        {hydrated ? message : <ListLoading className="py-0" />}
      </td>
    </tr>
  );
}

const PENDING_DEPOSIT_STATUSES = new Set(["pending_match", "matched", "pending"]);

export default function DashboardPage() {
  const me = useStore((s) => s.me);
  const hydrated = useStore((s) => s.hydrated);
  const deposits = useStore((s) => s.deposits);
  const withdrawals = useStore((s) => s.withdrawals);
  const players = useStore((s) => s.players);
  const entities = useStore((s) => s.entities);
  const boAccounts = useStore((s) => s.boAccounts);
  const expenses = useStore((s) => s.expenses);
  const botHealth = useStore((s) => s.botHealth);
  const userName = useStore((s) => s.userName);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const companyInScope = useStore((s) => s.companyInScope);

  const today = new Date();
  const [dateFrom, setDateFrom] = useState(todayStr());
  const [dateTo, setDateTo] = useState(todayStr());

  const playerMap = useMemo(
    () => new Map(players.map((p) => [p.player_id, p])),
    [players],
  );

  const scopedDeposits = useMemo(
    () => deposits.filter((d) => companyInScope(d.company_entity_id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deposits, selectedCompanyId, selectedLeaderId],
  );
  const scopedWithdrawals = useMemo(
    () =>
      withdrawals.filter((w) =>
        companyInScope(playerMap.get(w.player_id)?.company_entity_id),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [withdrawals, playerMap, selectedCompanyId, selectedLeaderId],
  );
  const scopedPlayers = useMemo(
    () => players.filter((p) => companyInScope(p.company_entity_id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [players, selectedCompanyId, selectedLeaderId],
  );
  const scopedBoAccounts = useMemo(
    () => boAccounts.filter((b) => companyInScope(b.company_entity_id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boAccounts, selectedCompanyId, selectedLeaderId],
  );
  const scopedExpenses = useMemo(
    () => expenses.filter((e) => companyInScope(e.company_entity_id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expenses, selectedCompanyId, selectedLeaderId],
  );

  // --- Range-scoped money (deposits by deposit_date, withdrawals/expenses by their date) ---
  const rangeDeposits = scopedDeposits.filter((d) =>
    inRange(d.deposit_date, dateFrom, dateTo),
  );
  const rangeWithdrawals = scopedWithdrawals.filter((w) =>
    inRange(w.created_at, dateFrom, dateTo),
  );
  const rangeExpenses = scopedExpenses.filter((e) =>
    inRange(e.expense_date, dateFrom, dateTo),
  );

  const completedDeposits = rangeDeposits.filter((d) => d.status === "completed");
  const depositsTotal = completedDeposits.reduce(
    (sum, d) => sum + d.total_amount,
    0,
  );
  const paidWithdrawals = rangeWithdrawals.filter((w) => w.status === "paid");
  const withdrawalsTotal = paidWithdrawals.reduce(
    (sum, w) => sum + w.credit_pulled_amount,
    0,
  );

  // Profit = deposits − withdrawals − bonuses − expenses (failed rows excluded).
  const grossDeposits = rangeDeposits
    .filter((d) => d.status !== "failed")
    .reduce((sum, d) => sum + d.deposit_amount, 0);
  const grossBonuses = rangeDeposits
    .filter((d) => d.status !== "failed")
    .reduce((sum, d) => sum + d.bonus_amount, 0);
  const grossWithdrawals = rangeWithdrawals
    .filter((w) => w.status !== "failed")
    .reduce((sum, w) => sum + w.requested_amount, 0);
  const totalExpenses = rangeExpenses.reduce((sum, e) => sum + e.amount, 0);
  const profit = grossDeposits - grossWithdrawals - grossBonuses - totalExpenses;

  // Live states (not range-bound)
  const pendingDeposits = scopedDeposits.filter((d) =>
    PENDING_DEPOSIT_STATUSES.has(d.status),
  );
  const processingDeposits = scopedDeposits.filter(
    (d) => d.status === "processing",
  );

  const kioskPoints = scopedBoAccounts.reduce(
    (sum, b) => sum + b.current_credit,
    0,
  );

  // Bot process health (system-wide, not company-scoped).
  const botsOnline = botHealth.filter((b) =>
    isBotOnline(b.last_heartbeat_at),
  ).length;
  const botsAttention = botHealth.filter(
    (b) =>
      isBotOnline(b.last_heartbeat_at) &&
      (b.state === "stuck" || b.state === "error"),
  ).length;

  const recentDeposits = [...rangeDeposits]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);
  const recentWithdrawals = [...rangeWithdrawals]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  const activeCompany =
    selectedCompanyId === null
      ? null
      : entities.find((e) => e.entity_id === selectedCompanyId);

  const firstName = me?.full_name.split(" ")[0];
  const rangeLabel =
    dateFrom === dateTo ? "in range" : `${dateFrom} → ${dateTo}`;

  function setPreset(days: number) {
    setDateFrom(daysAgoStr(days));
    setDateTo(todayStr());
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            Welcome back{firstName ? `, ${firstName}` : ""} 👋
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {today.toLocaleDateString("en-US", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
            {activeCompany && (
              <>
                {" "}
                ·{" "}
                <span className="font-medium text-foreground">
                  {activeCompany.name}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              From
            </span>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 w-[140px]"
            />
          </div>
          <div className="space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              To
            </span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-8 w-[140px]"
            />
          </div>
          <div className="flex gap-1 pb-0.5">
            {(
              [
                ["Today", 0],
                ["7D", 7],
                ["30D", 30],
              ] as const
            ).map(([label, days]) => (
              <button
                key={label}
                onClick={() => setPreset(days)}
                className="h-7 cursor-pointer rounded-md border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Money — respects the date range */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile
          title="Deposits"
          value={formatRM(depositsTotal)}
          sub={`${completedDeposits.length} completed ${rangeLabel}`}
          icon={Wallet}
          tone="success"
        />
        <StatTile
          title="Withdrawals"
          value={formatRM(withdrawalsTotal)}
          sub={`${paidWithdrawals.length} paid out ${rangeLabel}`}
          icon={Banknote}
        />
        <StatTile
          title="Profit"
          value={formatRM(profit)}
          sub="Deposits − withdrawals − bonuses − expenses"
          icon={TrendingUp}
          tone={profit >= 0 ? "success" : "danger"}
          valueClassName={profit >= 0 ? "text-emerald-600" : "text-rose-600"}
        />
        <StatTile
          title="Kiosk Points"
          value={formatRM(kioskPoints)}
          sub={`${scopedBoAccounts.length} kiosk${scopedBoAccounts.length === 1 ? "" : "s"}`}
          icon={Coins}
        />
      </div>

      {/* Live operational state */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile
          title="Pending Deposits"
          value={String(pendingDeposits.length)}
          sub="Waiting for CS action"
          icon={Clock}
          tone="warning"
        />
        <StatTile
          title="Processing"
          value={String(processingDeposits.length)}
          sub="Bot topping up now"
          icon={Loader2}
        />
        <StatTile
          title="Active Players"
          value={String(scopedPlayers.filter((p) => p.status === "active").length)}
          sub={`${scopedPlayers.length} total`}
          icon={Users}
        />
        <Link href="/bot-health" className="cursor-pointer">
          <Card className="gap-2 py-4 h-full transition-colors hover:border-primary/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1 px-5">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Bot Health
              </CardTitle>
              <Bot className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="px-5 space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Online</span>
                <span className="font-medium tabular-nums">
                  <span className={statusColor(botsOnline, botHealth.length)}>
                    {botsOnline}
                  </span>
                  <span className="text-muted-foreground"> / {botHealth.length}</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Needs attention</span>
                <span
                  className={cn(
                    "font-medium tabular-nums",
                    botsAttention > 0 ? "text-amber-600" : "text-muted-foreground",
                  )}
                >
                  {botsAttention}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground pt-0.5">
                Online = pinged &lt; 90s ago · click to view
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowDownRight className="h-4 w-4 text-emerald-600" />
              Recent Deposits
            </CardTitle>
            <span className="text-xs text-muted-foreground">Last 5</span>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Time</th>
                  <th className="px-4 py-2 text-left font-medium">Player</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 text-left font-medium">Handled by</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentDeposits.length === 0 ? (
                  <EmptyRow
                    colSpan={5}
                    hydrated={hydrated}
                    message="No deposits yet — they'll appear here as soon as the bot detects one."
                  />
                ) : (
                  recentDeposits.map((d) => (
                    <tr
                      key={d.deposit_id}
                      className={`border-t hover:bg-muted/30 ${
                        d.is_new ? "bg-emerald-500/10" : ""
                      }`}
                    >
                      <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                        {formatDateTime(d.created_at)}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {d.player_id != null ? (
                          <PlayerNameLink playerId={d.player_id}>
                            {d.player_username ??
                              playerMap.get(d.player_id)?.username ??
                              `P-${d.player_id}`}
                          </PlayerNameLink>
                        ) : (
                          <span className="text-muted-foreground">
                            {d.player_username ?? d.bank_description ?? "Unmatched"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap font-medium">
                        {formatRM(d.total_amount)}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                        {userName(d.handled_by_user_id)}
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={d.status} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowUpRight className="h-4 w-4 text-blue-600" />
              Recent Withdrawals
            </CardTitle>
            <span className="text-xs text-muted-foreground">Last 5</span>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Time</th>
                  <th className="px-4 py-2 text-left font-medium">Player</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 text-left font-medium">Handled by</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentWithdrawals.length === 0 ? (
                  <EmptyRow
                    colSpan={5}
                    hydrated={hydrated}
                    message="No withdrawals yet — player payout requests will show up here."
                  />
                ) : (
                  recentWithdrawals.map((w) => {
                    const player = playerMap.get(w.player_id);
                    return (
                      <tr
                        key={w.withdrawal_id}
                        className="border-t hover:bg-muted/30"
                      >
                        <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                          {formatDateTime(w.created_at)}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap">
                          <PlayerNameLink playerId={w.player_id}>
                            {player?.username ?? `P-${w.player_id}`}
                          </PlayerNameLink>
                        </td>
                        <td className="px-4 py-2 text-right whitespace-nowrap font-medium">
                          {formatRM(w.requested_amount)}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                          {userName(w.handled_by_user_id)}
                        </td>
                        <td className="px-4 py-2">
                          <StatusBadge status={w.status} />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

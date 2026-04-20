"use client";

import { useStore } from "@/lib/store";
import { PLAYERS } from "@/lib/mock-data";
import { formatRM, formatDateTime } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { PlayerNameLink } from "@/components/player-name-link";
import {
  Wallet,
  Clock,
  Banknote,
  Users,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";

function KpiCard({
  title,
  value,
  sub,
  icon: Icon,
  tone = "default",
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "warning" | "success";
}) {
  const toneCls =
    tone === "warning"
      ? "bg-amber-500/10 text-amber-600"
      : tone === "success"
        ? "bg-emerald-500/10 text-emerald-600"
        : "bg-primary/10 text-primary";
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1 px-5">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {title}
        </CardTitle>
        <div className={`flex h-8 w-8 items-center justify-center rounded-md ${toneCls}`}>
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent className="px-5">
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const deposits = useStore((s) => s.deposits);
  const withdrawals = useStore((s) => s.withdrawals);

  const today = new Date();
  const isSameDay = (iso: string) => {
    const d = new Date(iso);
    return (
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    );
  };

  const todaysDeposits = deposits.filter(
    (d) => isSameDay(d.created_at) && d.status === "completed",
  );
  const todaysDepositsTotal = todaysDeposits.reduce(
    (sum, d) => sum + d.total_amount,
    0,
  );
  const pendingDeposits = deposits.filter((d) => d.status === "pending");
  const todaysWithdrawals = withdrawals.filter(
    (w) => isSameDay(w.created_at) && w.status === "paid",
  );
  const todaysWithdrawalsTotal = todaysWithdrawals.reduce(
    (sum, w) => sum + w.credit_pulled_amount,
    0,
  );

  const recentDeposits = [...deposits]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);
  const recentWithdrawals = [...withdrawals]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome back, Ahmad 👋</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {today.toLocaleDateString("en-US", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Today's Deposits"
          value={formatRM(todaysDepositsTotal)}
          sub={`${todaysDeposits.length} completed`}
          icon={Wallet}
          tone="success"
        />
        <KpiCard
          title="Pending Deposits"
          value={String(pendingDeposits.length)}
          sub="Waiting for CS action"
          icon={Clock}
          tone="warning"
        />
        <KpiCard
          title="Today's Withdrawals"
          value={formatRM(todaysWithdrawalsTotal)}
          sub={`${todaysWithdrawals.length} paid out`}
          icon={Banknote}
        />
        <KpiCard
          title="Active Players"
          value={String(PLAYERS.filter((p) => p.status === "active").length)}
          sub={`${PLAYERS.length} total`}
          icon={Users}
        />
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
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentDeposits.map((d) => (
                  <tr key={d.deposit_id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                      {formatDateTime(d.created_at)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <PlayerNameLink playerId={d.player_id}>
                        {d.player_username}
                      </PlayerNameLink>
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap font-medium">
                      {formatRM(d.total_amount)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={d.status} />
                    </td>
                  </tr>
                ))}
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
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentWithdrawals.map((w) => {
                  const player = PLAYERS.find((p) => p.player_id === w.player_id);
                  return (
                    <tr key={w.withdrawal_id} className="border-t hover:bg-muted/30">
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
                      <td className="px-4 py-2">
                        <StatusBadge status={w.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

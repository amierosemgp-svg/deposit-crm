"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { PLAYERS, USERS } from "@/lib/mock-data";
import { formatRM, formatDateTime } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { PlayerNameLink } from "@/components/player-name-link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Filter } from "lucide-react";

type Row = {
  id: string;
  created_at: string;
  type: "Deposit" | "Withdrawal" | "Transfer";
  player_id: number;
  amount: number;
  bonus: string;
  game: string;
  agent: string;
  status: string;
  reference: string;
};

export default function HistoryPage() {
  const deposits = useStore((s) => s.deposits);
  const withdrawals = useStore((s) => s.withdrawals);
  const transfers = useStore((s) => s.gameTransfers);
  const [type, setType] = useState<string>("all");
  const [q, setQ] = useState("");

  const rows = useMemo<Row[]>(() => {
    const agentFor = (uid?: number) =>
      uid ? USERS.find((u) => u.user_id === uid)?.username ?? "—" : "—";

    const d: Row[] = deposits.map((x) => ({
      id: `D-${x.deposit_id}`,
      created_at: x.created_at,
      type: "Deposit",
      player_id: x.player_id,
      amount: x.total_amount,
      bonus:
        x.bonus_percentage > 0
          ? `+${x.bonus_percentage}% (${formatRM(x.bonus_amount)})`
          : "—",
      game: x.selected_game ?? "—",
      agent: agentFor(x.handled_by_user_id),
      status: x.status,
      reference: x.game_topup_reference ?? x.transaction_ref,
    }));

    const w: Row[] = withdrawals.map((x) => ({
      id: `W-${x.withdrawal_id}`,
      created_at: x.created_at,
      type: "Withdrawal",
      player_id: x.player_id,
      amount: x.requested_amount,
      bonus: "—",
      game: x.game_name,
      agent: agentFor(x.handled_by_user_id),
      status: x.status,
      reference: `WDL-${x.withdrawal_id}`,
    }));

    const t: Row[] = transfers.map((x) => ({
      id: `T-${x.transfer_id}`,
      created_at: x.created_at,
      type: "Transfer",
      player_id: x.player_id,
      amount: x.transfer_amount,
      bonus: "—",
      game: `${x.from_game} → ${x.to_game}`,
      agent: agentFor(x.handled_by_user_id),
      status: x.status,
      reference: `TRF-${x.transfer_id}`,
    }));

    return [...d, ...w, ...t].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
  }, [deposits, withdrawals, transfers]);

  const filtered = rows
    .filter((r) => type === "all" || r.type === type)
    .filter((r) => {
      if (!q) return true;
      const p = PLAYERS.find((x) => x.player_id === r.player_id);
      const hay = `${r.id} ${r.reference} ${p?.full_name ?? ""} ${p?.username ?? ""}`.toLowerCase();
      return hay.includes(q.toLowerCase());
    });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Transaction History</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Full audit log of deposits, withdrawals, and game credit transfers
        </p>
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <Select value={type} onValueChange={(v) => setType(v ?? "all")}>
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="Deposit">Deposits</SelectItem>
              <SelectItem value="Withdrawal">Withdrawals</SelectItem>
              <SelectItem value="Transfer">Transfers</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search player, reference…"
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {filtered.length} records
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Date</th>
                <th className="px-3 py-2.5 text-left font-medium">Type</th>
                <th className="px-3 py-2.5 text-left font-medium">Player</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Amount</th>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Bonus</th>
                <th className="px-3 py-2.5 text-left font-medium">Game</th>
                <th className="px-3 py-2.5 text-left font-medium">CS Agent</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Reference ID</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const p = PLAYERS.find((x) => x.player_id === r.player_id);
                return (
                  <tr key={r.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap text-[12px]">
                      {formatDateTime(r.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          r.type === "Deposit"
                            ? "inline-flex items-center rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700"
                            : r.type === "Withdrawal"
                              ? "inline-flex items-center rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-700"
                              : "inline-flex items-center rounded-md bg-purple-500/10 px-1.5 py-0.5 text-[11px] font-medium text-purple-700"
                        }
                      >
                        {r.type}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <PlayerNameLink playerId={r.player_id}>
                        {p?.username ?? `P-${r.player_id}`}
                      </PlayerNameLink>
                    </td>
                    <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {formatRM(r.amount)}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">
                      {r.bonus}
                    </td>
                    <td className="px-3 py-2 text-[12px]">{r.game}</td>
                    <td className="px-3 py-2 text-[12px] text-muted-foreground">
                      {r.agent}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={r.status as any} />
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                      {r.reference}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

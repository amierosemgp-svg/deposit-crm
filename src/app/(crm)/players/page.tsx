"use client";

import { useMemo, useState } from "react";
import { PLAYERS, COMPANIES } from "@/lib/mock-data";
import { useStore } from "@/lib/store";
import { formatRM, formatRelative, initialsOf } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/status-badge";
import { PlayerNameLink } from "@/components/player-name-link";
import { ImportPlayersModal } from "@/components/import-players-modal";
import { CreatePlayerModal } from "@/components/create-player-modal";
import { Search, Send, Upload, UserPlus } from "lucide-react";

export default function PlayersPage() {
  const importedPlayers = useStore((s) => s.importedPlayers);
  const [q, setQ] = useState("");
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const allPlayers = useMemo(
    () => [...importedPlayers, ...PLAYERS],
    [importedPlayers],
  );

  const filtered = allPlayers.filter((p) => {
    const matchQ =
      !q ||
      p.full_name.toLowerCase().includes(q.toLowerCase()) ||
      p.username.toLowerCase().includes(q.toLowerCase()) ||
      p.telegram_username.toLowerCase().includes(q.toLowerCase());
    const matchC =
      companyFilter === "all" || String(p.company_id) === companyFilter;
    return matchQ && matchC;
  });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Players</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {allPlayers.length} total players across {COMPANIES.length} companies
            {importedPlayers.length > 0 && (
              <span className="ml-1.5 inline-flex items-center rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                +{importedPlayers.length} imported
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setImportOpen(true)}
            variant="outline"
            size="sm"
            className="cursor-pointer"
          >
            <Upload className="h-3.5 w-3.5" />
            Import Players
          </Button>
          <Button
            onClick={() => setCreateOpen(true)}
            size="sm"
            className="cursor-pointer"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Create Player
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <div className="relative flex-1 min-w-48 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, username, Telegram…"
              className="h-8 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>
          <select
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none"
          >
            <option value="all">All companies</option>
            {COMPANIES.map((c) => (
              <option key={c.company_id} value={c.company_id}>
                {c.company_name}
              </option>
            ))}
          </select>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {filtered.length} shown
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium">Player</th>
                <th className="px-3 py-2.5 text-left font-medium">Company</th>
                <th className="px-3 py-2.5 text-left font-medium">Contact</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Total Deposits</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Total Withdrawals</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-left font-medium">Joined</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const company = COMPANIES.find((c) => c.company_id === p.company_id);
                return (
                  <tr key={p.player_id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2.5">
                        <Avatar className="h-7 w-7">
                          <AvatarFallback className="text-[10px]">
                            {initialsOf(p.full_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <PlayerNameLink playerId={p.player_id}>
                            {p.full_name}
                          </PlayerNameLink>
                          <div className="text-[10px] text-muted-foreground">
                            @{p.username} · P-{p.player_id}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[12px]">
                      {company?.company_name ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="inline-flex items-center gap-1 text-[11px]">
                        <Send className="h-3 w-3 text-muted-foreground" />
                        {p.telegram_username}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {formatRM(p.total_deposits)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-muted-foreground">
                      {formatRM(p.total_withdrawals)}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">
                      {formatRelative(p.registration_date)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <ImportPlayersModal open={importOpen} onOpenChange={setImportOpen} />
      <CreatePlayerModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

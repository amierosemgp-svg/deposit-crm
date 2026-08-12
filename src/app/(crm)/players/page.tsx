"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { formatRM, formatRelative, initialsOf } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { ListLoading } from "@/components/list-loading";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/status-badge";
import { PlayerNameLink } from "@/components/player-name-link";
import { ImportPlayersModal } from "@/components/import-players-modal";
import { CreatePlayerModal } from "@/components/create-player-modal";
import { Search, Send, Upload, UserPlus, Users } from "lucide-react";

export default function PlayersPage() {
  const players = useStore((s) => s.players);
  const hydrated = useStore((s) => s.hydrated);
  const entityName = useStore((s) => s.entityName);
  const companiesFn = useStore((s) => s.companies);
  const me = useStore((s) => s.me);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const companyInScope = useStore((s) => s.companyInScope);
  const [q, setQ] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const isViewer = me?.role === "viewer";
  const companies = companiesFn();
  const activeCompany = companies.find(
    (c) => c.company_id === selectedCompanyId,
  );

  const filtered = useMemo(
    () =>
      players.filter((p) => {
        const matchQ =
          !q ||
          p.full_name.toLowerCase().includes(q.toLowerCase()) ||
          p.username.toLowerCase().includes(q.toLowerCase()) ||
          (p.telegram_username ?? "").toLowerCase().includes(q.toLowerCase());
        return matchQ && companyInScope(p.company_entity_id);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [players, q, selectedCompanyId, selectedLeaderId],
  );

  const inScopeTotal = players.filter((p) =>
    companyInScope(p.company_entity_id),
  ).length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Players</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {activeCompany ? (
              <>
                {inScopeTotal} players in{" "}
                <span className="font-medium text-foreground">
                  {activeCompany.company_name}
                </span>
              </>
            ) : (
              <>
                {players.length} total players across {companies.length}{" "}
                companies
              </>
            )}
          </p>
        </div>
        {!isViewer && (
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
        )}
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
          <span className="ml-auto text-[11px] text-muted-foreground">
            {filtered.length} shown
          </span>
        </div>

        {!hydrated ? (
          <ListLoading label="Loading players…" className="py-14" />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-14 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Users className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium">
              {q ? "No players match your search" : "No players yet"}
            </p>
            <p className="text-[12px] text-muted-foreground max-w-sm">
              {q
                ? "Try a different name, username or Telegram handle."
                : isViewer
                  ? "Players will appear here once they are registered."
                  : "Create a player or import a batch via CSV to get started."}
            </p>
          </div>
        ) : (
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
                {filtered.map((p) => (
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
                      {entityName(p.company_entity_id)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="inline-flex items-center gap-1 text-[11px]">
                        <Send className="h-3 w-3 text-muted-foreground" />
                        {p.telegram_username ?? "—"}
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ImportPlayersModal open={importOpen} onOpenChange={setImportOpen} />
      <CreatePlayerModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

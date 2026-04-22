"use client";

import { useState, useMemo } from "react";
import { useStore } from "@/lib/store";
import { PLAYERS, CURRENT_USER } from "@/lib/mock-data";
import { GAMES, type GameName } from "@/lib/types";
import { formatRM, formatDateTime } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlayerNameLink } from "@/components/player-name-link";
import { StatusBadge } from "@/components/status-badge";
import { ArrowLeftRight, Search } from "lucide-react";
import { toast } from "sonner";

export default function GameTransferPage() {
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [fromGame, setFromGame] = useState<GameName>("Mega888");
  const [toGame, setToGame] = useState<GameName>("Pussy888");
  const [amount, setAmount] = useState("");

  const transfers = useStore((s) => s.gameTransfers);
  const getBalance = useStore((s) => s.getCreditBalance);
  const createTransfer = useStore((s) => s.createGameTransfer);
  const importedPlayers = useStore((s) => s.importedPlayers);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);

  const playerMatches = useMemo(() => {
    if (!playerQuery) return [];
    const q = playerQuery.toLowerCase();
    return [...PLAYERS, ...importedPlayers]
      .filter(
        (p) =>
          (p.full_name.toLowerCase().includes(q) ||
            p.username.toLowerCase().includes(q)) &&
          (selectedCompanyId === null || p.company_id === selectedCompanyId),
      )
      .slice(0, 5);
  }, [playerQuery, importedPlayers, selectedCompanyId]);

  const playerCompanyMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const p of PLAYERS) map.set(p.player_id, p.company_id);
    for (const p of importedPlayers) map.set(p.player_id, p.company_id);
    return map;
  }, [importedPlayers]);

  const scopedTransfers = useMemo(
    () =>
      transfers.filter(
        (t) =>
          selectedCompanyId === null ||
          playerCompanyMap.get(t.player_id) === selectedCompanyId,
      ),
    [transfers, selectedCompanyId, playerCompanyMap],
  );

  const player = playerId ? PLAYERS.find((p) => p.player_id === playerId) : null;
  const fromBal = player ? getBalance(player.player_id, fromGame) : 0;
  const amt = Number(amount) || 0;
  const canTransfer = player && amt > 0 && amt <= fromBal && fromGame !== toGame;

  function handleTransfer() {
    if (!player || !canTransfer) return;
    createTransfer({
      playerId: player.player_id,
      fromGame,
      toGame,
      amount: amt,
      handledByUserId: CURRENT_USER.user_id,
    });
    toast.success(`Transferred ${formatRM(amt)} from ${fromGame} to ${toGame}`);
    setAmount("");
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Game Credit Transfer</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Move credits between games for a single player
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4 text-primary" />
              New Transfer
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Player</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={player ? `${player.full_name} (@${player.username})` : playerQuery}
                  onChange={(e) => {
                    setPlayerQuery(e.target.value);
                    setPlayerId(null);
                  }}
                  placeholder="Search player…"
                  className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                />
                {!player && playerMatches.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-10 rounded-md border bg-popover shadow-md">
                    {playerMatches.map((p) => (
                      <button
                        key={p.player_id}
                        onClick={() => {
                          setPlayerId(p.player_id);
                          setPlayerQuery("");
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
                      >
                        <div>
                          <div className="font-medium">{p.full_name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            @{p.username}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>From Game</Label>
              <Select value={fromGame} onValueChange={(v) => setFromGame(v as GameName)}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GAMES.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {player && (
                <p className="text-[11px] text-muted-foreground">
                  Current balance: <span className="font-medium">{formatRM(fromBal)}</span>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>To Game</Label>
              <Select value={toGame} onValueChange={(v) => setToGame(v as GameName)}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GAMES.filter((g) => g !== fromGame).map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Amount (RM)</Label>
              <Input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                min={0}
                max={fromBal}
              />
              {player && amt > fromBal && (
                <p className="text-[11px] text-red-600">Exceeds current balance</p>
              )}
            </div>

            <Button
              onClick={handleTransfer}
              disabled={!canTransfer}
              className="w-full h-9"
            >
              Transfer Credits
            </Button>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 p-0 gap-0 overflow-hidden">
          <CardHeader className="border-b">
            <CardTitle className="text-base">Recent Transfers</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium">Date</th>
                  <th className="px-3 py-2.5 text-left font-medium">Player</th>
                  <th className="px-3 py-2.5 text-left font-medium">From</th>
                  <th className="px-3 py-2.5 text-left font-medium">To</th>
                  <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-3 py-2.5 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {scopedTransfers.map((t) => {
                  const p = PLAYERS.find((x) => x.player_id === t.player_id);
                  return (
                    <tr key={t.transfer_id} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2 whitespace-nowrap text-[12px]">
                        {formatDateTime(t.created_at)}
                      </td>
                      <td className="px-3 py-2">
                        <PlayerNameLink playerId={t.player_id}>
                          {p?.username ?? `P-${t.player_id}`}
                        </PlayerNameLink>
                      </td>
                      <td className="px-3 py-2 text-[12px]">{t.from_game}</td>
                      <td className="px-3 py-2 text-[12px]">{t.to_game}</td>
                      <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                        {formatRM(t.transfer_amount)}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={t.status === "completed" ? "completed" : t.status === "failed" ? "failed" : "pending"} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

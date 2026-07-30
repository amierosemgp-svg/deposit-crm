"use client";

import { useState, useMemo, useEffect } from "react";
import { useStore } from "@/lib/store";
import {
  formatRM,
  formatDateTime,
  formatDuration,
} from "@/lib/format";
import {
  IN_FLIGHT_TRANSFER_STATUSES,
  MAX_TRANSFER_ATTEMPTS,
  type GameTransfer,
} from "@/lib/types";
import { AssigneeCell } from "@/components/assignee-cell";
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
import { ListLoading } from "@/components/list-loading";
import { ArrowLeftRight, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

/**
 * When a transfer last moved. Finished ones show the completed/failed time and
 * how long the move took; one still in flight shows how long it has been
 * running, which is the number CS actually watches — a transfer sitting in
 * "processing" is the bot failing to report back.
 */
function TransferTiming({ transfer }: { transfer: GameTransfer }) {
  // Stays null until mount, so SSR and the first client render agree.
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date().toISOString());
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const started = transfer.started_at ?? transfer.created_at;
  const ended = transfer.completed_at;
  const inFlight = (
    IN_FLIGHT_TRANSFER_STATUSES as string[]
  ).includes(transfer.status);

  if (ended) {
    return (
      <div className="leading-snug">
        <div>{formatDateTime(ended)}</div>
        <div className="text-[11px] text-muted-foreground">
          took {formatDuration(started, ended)}
        </div>
      </div>
    );
  }

  if (inFlight) {
    return (
      <div className="leading-snug">
        <div className="text-muted-foreground">—</div>
        <div className="text-[11px] text-muted-foreground">
          {now ? `running ${formatDuration(started, now)}` : " "}
        </div>
      </div>
    );
  }

  // Finished before end times were being recorded.
  return <span className="text-muted-foreground italic">not recorded</span>;
}

export default function GameTransferPage() {
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [fromGameSel, setFromGameSel] = useState("");
  const [toGameSel, setToGameSel] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const transfers = useStore((s) => s.gameTransfers);
  const hydrated = useStore((s) => s.hydrated);
  const players = useStore((s) => s.players);
  const getBalance = useStore((s) => s.getCreditBalance);
  const createTransfer = useStore((s) => s.createGameTransfer);
  const playerById = useStore((s) => s.playerById);
  const userName = useStore((s) => s.userName);
  const gamesFn = useStore((s) => s.games);
  const me = useStore((s) => s.me);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const companyInScope = useStore((s) => s.companyInScope);

  const isViewer = me?.role === "viewer";
  const games = gamesFn();
  const fromGame = fromGameSel || games[0] || "";
  const toGame =
    toGameSel && toGameSel !== fromGame
      ? toGameSel
      : (games.find((g) => g !== fromGame) ?? "");

  const playerMatches = useMemo(() => {
    if (!playerQuery) return [];
    const q = playerQuery.toLowerCase();
    return players
      .filter(
        (p) =>
          (p.full_name.toLowerCase().includes(q) ||
            p.username.toLowerCase().includes(q)) &&
          companyInScope(p.company_entity_id),
      )
      .slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerQuery, players, selectedCompanyId, selectedLeaderId]);

  const scopedTransfers = useMemo(
    () =>
      transfers.filter((t) =>
        companyInScope(playerById(t.player_id)?.company_entity_id),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transfers, selectedCompanyId, selectedLeaderId, playerById],
  );

  const player = playerId ? playerById(playerId) : undefined;
  const fromBal = player ? getBalance(player.player_id, fromGame) : 0;
  const amt = Number(amount) || 0;
  const canTransfer =
    !!player && amt > 0 && amt <= fromBal && !!fromGame && !!toGame && fromGame !== toGame;

  async function handleTransfer() {
    if (!player || !canTransfer || submitting) return;
    setSubmitting(true);
    const res = await createTransfer({
      playerId: player.player_id,
      fromGame,
      toGame,
      amount: amt,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error ?? "Transfer failed");
      return;
    }
    toast.success(
      `Transfer queued — ${formatRM(amt)} from ${fromGame} to ${toGame}, waiting for the bot`,
    );
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
        {!isViewer && (
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
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted cursor-pointer"
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
                <Select value={fromGame} onValueChange={(v) => setFromGameSel(v ?? "")}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {games.map((g) => (
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
                <Select value={toGame} onValueChange={(v) => setToGameSel(v ?? "")}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {games
                      .filter((g) => g !== fromGame)
                      .map((g) => (
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
                disabled={!canTransfer || submitting}
                className="w-full h-9 cursor-pointer"
              >
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Transfer Credits
              </Button>
            </CardContent>
          </Card>
        )}

        <Card
          className={
            isViewer
              ? "lg:col-span-3 p-0 gap-0 overflow-hidden"
              : "lg:col-span-2 p-0 gap-0 overflow-hidden"
          }
        >
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
                  <th className="px-3 py-2.5 text-left font-medium">
                    Requested by
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    Handled by
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">Status</th>
                  <th className="px-3 py-2.5 text-left font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {scopedTransfers.length === 0 && (
                  <tr className="border-t">
                    <td
                      colSpan={9}
                      className="px-3 py-10 text-center text-sm text-muted-foreground"
                    >
                      {!hydrated ? (
                        <ListLoading className="py-0" label="Loading transfers…" />
                      ) : (
                        "No game transfers yet — they will show up here once credits are moved between games."
                      )}
                    </td>
                  </tr>
                )}
                {scopedTransfers.map((t) => {
                  const p = playerById(t.player_id);
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
                      <td className="px-3 py-2 text-[12px] text-muted-foreground">
                        {userName(t.handled_by_user_id)}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <AssigneeCell
                          kind="game_transfer"
                          id={t.transfer_id}
                          assignedToUserId={t.assigned_to_user_id}
                        />
                      </td>
                      <td className="px-3 py-2 align-top">
                        <StatusBadge
                          status={t.status}
                          // "pending" here means queued for the bot, not
                          // awaiting a person.
                          label={t.status === "pending" ? "Initializing" : undefined}
                        />
                        {t.status === "solving" && (
                          <p className="mt-1 text-[11px] text-violet-700">
                            recovering — attempt {t.attempt_count} of{" "}
                            {MAX_TRANSFER_ATTEMPTS}
                          </p>
                        )}
                        {t.status === "processing" && t.attempt_count > 1 && (
                          <p className="mt-1 text-[11px] text-amber-600">
                            retry {t.attempt_count} of {MAX_TRANSFER_ATTEMPTS}
                          </p>
                        )}
                        {t.note && (
                          <p
                            className={`mt-1 max-w-[220px] text-[11px] leading-snug ${
                              t.status === "failed"
                                ? "text-red-600"
                                : "text-muted-foreground"
                            }`}
                            title={t.note}
                          >
                            {t.note}
                          </p>
                        )}
                        {t.status === "failed" && !t.note && (
                          <p className="mt-1 text-[11px] italic text-muted-foreground">
                            No reason given
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap text-[12px]">
                        <TransferTiming transfer={t} />
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

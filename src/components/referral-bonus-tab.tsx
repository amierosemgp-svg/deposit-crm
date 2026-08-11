"use client";

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { formatRM, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ListLoading } from "@/components/list-loading";
import { SearchableSelect } from "@/components/searchable-select";
import { PlayerNameLink } from "@/components/player-name-link";
import { cn } from "@/lib/utils";
import { Gift, Loader2, Users, X } from "lucide-react";
import { toast } from "sonner";

type Bonus = {
  bonus_id: number;
  downline_player_id: number;
  downline_username: string | null;
  downline_full_name: string | null;
  deposit_id: number | null;
  deposit_amount: number;
  bonus_percentage: number;
  bonus_amount: number;
  status: "pending" | "assigned" | "cancelled";
  game_name: string | null;
  skip_bot: boolean;
  game_transfer_id: number | null;
  assigned_by_user_id: number | null;
  assigned_at: string | null;
  created_at: string;
};

const STATUS_STYLE: Record<Bonus["status"], string> = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  assigned: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  cancelled: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
};

/**
 * What this player has earned by referring others: 20% of each downline's
 * first deposit, paid once. CS picks which of the upline's games the credit
 * goes into, and whether the bot moves it or they already did it by hand.
 */
export function ReferralBonusTab({ playerId }: { playerId: number }) {
  const [assigning, setAssigning] = useState<number | null>(null);
  const [game, setGame] = useState("");
  const [skipBot, setSkipBot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  const playerById = useStore((s) => s.playerById);
  const userName = useStore((s) => s.userName);
  const isViewer = useStore((s) => s.me?.role === "viewer");
  const assignBonus = useStore((s) => s.assignReferralBonus);

  const player = playerById(playerId);
  // Credit must land somewhere the player can actually reach.
  const uplineGames = (player?.game_accounts ?? [])
    .map((g) => g.game_name)
    .sort((a, b) => a.localeCompare(b));

  const requestKey = `${playerId}:${version}`;
  const [result, setResult] = useState<{
    key: string;
    bonuses: Bonus[];
    pendingTotal: number;
    error: string | null;
  }>({ key: "", bonuses: [], pendingTotal: 0, error: null });

  const load = useCallback(async () => {
    const res = await fetch(`/api/players/${playerId}/referral-bonuses`);
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    return d as { bonuses: Bonus[]; pending_total: number };
  }, [playerId]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => {
        if (cancelled) return;
        setResult({
          key: requestKey,
          bonuses: d.bonuses,
          pendingTotal: d.pending_total,
          error: null,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setResult({
          key: requestKey,
          bonuses: [],
          pendingTotal: 0,
          error: e instanceof Error ? e.message : "Could not load bonuses",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [load, requestKey]);

  const loading = result.key !== requestKey;
  const bonuses = loading ? [] : result.bonuses;
  const pendingTotal = loading ? 0 : result.pendingTotal;
  const error = loading ? null : result.error;

  function startAssign(bonusId: number) {
    setAssigning(bonusId);
    setGame(uplineGames[0] ?? "");
    setSkipBot(false);
  }

  async function confirmAssign(bonus: Bonus) {
    if (!game || busy) return;
    setBusy(true);
    const res = await assignBonus(bonus.bonus_id, {
      game_name: game,
      skip_bot: skipBot,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error ?? "Could not assign the bonus");
      return;
    }
    toast.success(
      skipBot
        ? `${formatRM(bonus.bonus_amount)} credited to ${game}`
        : `${formatRM(bonus.bonus_amount)} queued for the bot to credit in ${game}`,
    );
    setAssigning(null);
    setVersion((v) => v + 1);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
        <Gift className="h-4 w-4 text-muted-foreground" />
        <span className="text-[12px] text-muted-foreground">
          20% of each downline&apos;s <b>first</b> deposit, earned once per
          downline.
        </span>
        {pendingTotal > 0 && (
          <span className="ml-auto text-[12px]">
            <span className="text-muted-foreground">Unassigned </span>
            <span className="font-semibold text-amber-600 dark:text-amber-400">
              {formatRM(pendingTotal)}
            </span>
          </span>
        )}
      </div>

      {error ? (
        <p className="py-6 text-center text-sm text-rose-600 dark:text-rose-400">{error}</p>
      ) : loading ? (
        <ListLoading label="Loading bonuses…" />
      ) : bonuses.length === 0 ? (
        <div className="py-12 text-center">
          <Users className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            No referral bonuses yet.
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            One appears here the moment a downline&apos;s first deposit
            completes.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {bonuses.map((b) => (
            <li key={b.bonus_id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PlayerNameLink playerId={b.downline_player_id}>
                      {b.downline_username ?? `P-${b.downline_player_id}`}
                    </PlayerNameLink>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                        STATUS_STYLE[b.status],
                      )}
                    >
                      {b.status}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {b.bonus_percentage}% of {formatRM(b.deposit_amount)} first
                    deposit · {formatDateTime(b.created_at)}
                  </div>
                  {b.status === "assigned" && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Credited to <b>{b.game_name}</b>{" "}
                      {b.skip_bot ? "by hand" : "by the bot"}
                      {b.game_transfer_id && ` · transfer #${b.game_transfer_id}`}
                      {b.assigned_by_user_id &&
                        ` · ${userName(b.assigned_by_user_id)}`}
                    </div>
                  )}
                </div>

                <div className="text-right">
                  <div className="font-semibold whitespace-nowrap">
                    {formatRM(b.bonus_amount)}
                  </div>
                  {b.status === "pending" && !isViewer && assigning !== b.bonus_id && (
                    <Button
                      size="sm"
                      onClick={() => startAssign(b.bonus_id)}
                      disabled={uplineGames.length === 0}
                      title={
                        uplineGames.length === 0
                          ? "Link a game account to this player first"
                          : undefined
                      }
                      className="mt-1 h-7 cursor-pointer"
                    >
                      Assign
                    </Button>
                  )}
                </div>
              </div>

              {assigning === b.bonus_id && (
                <div className="mt-3 space-y-2 rounded-md border bg-muted/20 p-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium">
                      Credit into which game?
                    </label>
                    <SearchableSelect
                      value={game || null}
                      onValueChange={setGame}
                      options={uplineGames}
                      placeholder="Pick game"
                      emptyMessage="No games linked to this player"
                      searchPlaceholder="Search game…"
                      className="h-8 text-[12px]"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium">How?</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setSkipBot(false)}
                        className={cn(
                          "cursor-pointer rounded-md border px-2 py-1.5 text-left text-[12px]",
                          !skipBot
                            ? "border-primary bg-primary/5 font-medium"
                            : "hover:bg-muted",
                        )}
                      >
                        Let the bot do it
                        <span className="block text-[10px] font-normal text-muted-foreground">
                          Queued; credit lands when it reports back
                        </span>
                      </button>
                      <button
                        onClick={() => setSkipBot(true)}
                        className={cn(
                          "cursor-pointer rounded-md border px-2 py-1.5 text-left text-[12px]",
                          skipBot
                            ? "border-primary bg-primary/5 font-medium"
                            : "hover:bg-muted",
                        )}
                      >
                        I already did it
                        <span className="block text-[10px] font-normal text-muted-foreground">
                          Books the credit now
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="flex justify-end gap-1.5 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setAssigning(null)}
                      disabled={busy}
                      className="cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void confirmAssign(b)}
                      disabled={!game || busy}
                      className="cursor-pointer"
                    >
                      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Assign {formatRM(b.bonus_amount)}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

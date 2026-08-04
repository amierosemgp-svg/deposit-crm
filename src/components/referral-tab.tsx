"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { formatRM, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { PlayerNameLink } from "@/components/player-name-link";
import { cn } from "@/lib/utils";
import { ArrowUp, ArrowDown, Loader2, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";

/**
 * Who referred this player, and who they referred.
 *
 * The upline is the money-bearing link — it decides who gets 20% of this
 * player's first deposit — so it's set here deliberately by CS rather than
 * inferred from anything.
 */
export function ReferralTab({ playerId }: { playerId: number }) {
  const [query, setQuery] = useState("");
  // Which candidate is being linked — drives the per-row spinner. A bare
  // boolean can't say *which* name was clicked, which is what made the click
  // feel like nothing had happened.
  const [linkingId, setLinkingId] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);
  const [picking, setPicking] = useState(false);
  // Adding a downline is the same link written from the other end.
  const [addingDownline, setAddingDownline] = useState(false);
  const [downlineQuery, setDownlineQuery] = useState("");
  const busy = linkingId !== null || removing;

  const players = useStore((s) => s.players);
  const playerById = useStore((s) => s.playerById);
  const companyInScope = useStore((s) => s.companyInScope);
  const isViewer = useStore((s) => s.me?.role === "viewer");
  const setUpline = useStore((s) => s.setUpline);

  const player = playerById(playerId);
  const upline = player?.upline_player_id
    ? playerById(player.upline_player_id)
    : undefined;

  const downlines = useMemo(
    () => players.filter((p) => p.upline_player_id === playerId),
    [players, playerId],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return players
      .filter(
        (p) =>
          p.player_id !== playerId &&
          companyInScope(p.company_entity_id) &&
          (p.full_name.toLowerCase().includes(q) ||
            p.username.toLowerCase().includes(q)),
      )
      .slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, players, playerId]);

  const downlineMatches = useMemo(() => {
    const q = downlineQuery.trim().toLowerCase();
    if (!q) return [];
    return players
      .filter(
        (p) =>
          p.player_id !== playerId &&
          // Already this player's downline — nothing to do.
          p.upline_player_id !== playerId &&
          companyInScope(p.company_entity_id) &&
          (p.full_name.toLowerCase().includes(q) ||
            p.username.toLowerCase().includes(q)),
      )
      .slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downlineQuery, players, playerId]);

  /**
   * Point another player's upline at this one. Same endpoint as setting an
   * upline — the roles are just reversed — so the cycle and scope guards on
   * the server apply unchanged.
   */
  async function addDownline(downlinePlayerId: number) {
    if (busy) return;
    const candidate = playerById(downlinePlayerId);
    // Reassigning someone who already has an upline silently moves the bonus
    // off whoever referred them; make that a decision, not a side effect.
    if (candidate?.upline_player_id) {
      const current = playerById(candidate.upline_player_id);
      const ok = confirm(
        `${candidate.full_name} is already referred by ${current?.full_name ?? `player ${candidate.upline_player_id}`}.\n\n` +
          `Move them under ${player?.full_name}? Any unassigned bonus moves too.`,
      );
      if (!ok) return;
    }
    setLinkingId(downlinePlayerId);
    const res = await setUpline(downlinePlayerId, playerId);
    setLinkingId(null);
    if (!res.ok) {
      toast.error(res.error ?? "Could not add the downline");
      return;
    }
    toast.success(`${candidate?.full_name ?? "Player"} added as a downline`);
    setAddingDownline(false);
    setDownlineQuery("");
  }

  async function assignUpline(uplineId: number | null) {
    if (busy) return;
    if (uplineId === null) setRemoving(true);
    else setLinkingId(uplineId);
    const res = await setUpline(playerId, uplineId);
    setLinkingId(null);
    setRemoving(false);
    if (!res.ok) {
      toast.error(res.error ?? "Could not update the upline");
      return;
    }
    toast.success(uplineId === null ? "Upline removed" : "Upline set");
    setPicking(false);
    setQuery("");
  }

  if (!player) return null;

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <ArrowUp className="h-3 w-3" />
          Upline (referred by)
        </h3>

        {upline ? (
          <div className="flex items-center gap-2 rounded-md border p-3">
            <div className="min-w-0 flex-1">
              <PlayerNameLink playerId={upline.player_id}>
                {upline.full_name}
              </PlayerNameLink>
              <div className="text-[11px] text-muted-foreground">
                @{upline.username}
                {player.upline_assigned_at &&
                  ` · linked ${formatDateTime(player.upline_assigned_at)}`}
              </div>
            </div>
            {!isViewer && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void assignUpline(null)}
                disabled={busy}
                className="cursor-pointer"
              >
                {removing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                Remove
              </Button>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-3">
            <p className="text-[12px] text-muted-foreground">
              No upline. This player wasn&apos;t referred by anyone, so nobody
              earns from their first deposit.
            </p>
            {!isViewer && !picking && (
              <Button
                size="sm"
                onClick={() => setPicking(true)}
                className="mt-2 h-7 cursor-pointer"
              >
                Set upline
              </Button>
            )}
          </div>
        )}

        {picking && !isViewer && (
          <div className="mt-2 rounded-md border bg-muted/20 p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the player who referred them…"
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
              />
            </div>
            {matches.length > 0 && (
              <div className="mt-1 divide-y rounded-md border bg-popover">
                {matches.map((p) => {
                  const linking = linkingId === p.player_id;
                  return (
                    <button
                      key={p.player_id}
                      onClick={() => void assignUpline(p.player_id)}
                      disabled={busy}
                      className={cn(
                        "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed",
                        linking && "bg-muted",
                        busy && !linking && "opacity-50",
                      )}
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-medium">{p.full_name}</span>
                        <span className="ml-1.5 text-[11px] text-muted-foreground">
                          @{p.username}
                        </span>
                      </span>
                      {linking && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Linking…
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {query.trim() && matches.length === 0 && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                No player matches that.
              </p>
            )}
            <div className="mt-2 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPicking(false);
                  setQuery("");
                }}
                className="cursor-pointer"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <ArrowDown className="h-3 w-3" />
          Downlines
          {downlines.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
              {downlines.length}
            </span>
          )}
          {!isViewer && !addingDownline && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAddingDownline(true)}
              className="ml-auto h-6 cursor-pointer text-[11px] font-normal normal-case tracking-normal"
            >
              <Plus className="h-3 w-3" />
              Add downline
            </Button>
          )}
        </h3>

        {addingDownline && !isViewer && (
          <div className="mb-2 rounded-md border bg-muted/20 p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={downlineQuery}
                onChange={(e) => setDownlineQuery(e.target.value)}
                placeholder="Search the player they referred…"
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
              />
            </div>
            {downlineMatches.length > 0 && (
              <div className="mt-1 divide-y rounded-md border bg-popover">
                {downlineMatches.map((p) => {
                  const linking = linkingId === p.player_id;
                  const taken = p.upline_player_id != null;
                  return (
                    <button
                      key={p.player_id}
                      onClick={() => void addDownline(p.player_id)}
                      disabled={busy}
                      className={cn(
                        "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed",
                        linking && "bg-muted",
                        busy && !linking && "opacity-50",
                      )}
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-medium">{p.full_name}</span>
                        <span className="ml-1.5 text-[11px] text-muted-foreground">
                          @{p.username}
                        </span>
                        {taken && (
                          <span className="ml-1.5 text-[10px] text-amber-600">
                            already referred
                          </span>
                        )}
                      </span>
                      {linking && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Adding…
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {downlineQuery.trim() && downlineMatches.length === 0 && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                No player matches that.
              </p>
            )}
            <div className="mt-2 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAddingDownline(false);
                  setDownlineQuery("");
                }}
                className="cursor-pointer"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {downlines.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            Nobody has been referred by this player yet. Use{" "}
            <b>Add downline</b> above — their first deposit then earns a bonus
            you can hand out from the Recommend Bonus tab.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {downlines.map((d) => (
              <li key={d.player_id} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <PlayerNameLink playerId={d.player_id}>
                    {d.full_name}
                  </PlayerNameLink>
                  <div className="text-[11px] text-muted-foreground">
                    @{d.username}
                  </div>
                </div>
                <div className="text-right text-[11px]">
                  <div className="text-muted-foreground">Lifetime deposits</div>
                  <div
                    className={cn(
                      "font-medium",
                      d.total_deposits > 0
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatRM(d.total_deposits)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

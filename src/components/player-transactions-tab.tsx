"use client";

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { formatRM, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ListLoading } from "@/components/list-loading";
import { cn } from "@/lib/utils";
import { Loader2, Receipt, X } from "lucide-react";

type Entry = {
  transaction_id: number;
  type: string;
  amount: number;
  game_name: string | null;
  reference_id: number | null;
  details: Record<string, unknown> | null;
  user_id: number | null;
  user_name: string | null;
  created_at: string;
};

const TYPE_STYLE: Record<string, string> = {
  deposit: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  withdrawal: "border-rose-500/30 bg-rose-500/10 text-rose-700",
  game_topup: "border-sky-500/30 bg-sky-500/10 text-sky-700",
  game_transfer: "border-violet-500/30 bg-violet-500/10 text-violet-700",
  credit_pull: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  bank_transfer: "border-zinc-500/30 bg-zinc-500/10 text-zinc-700",
  bo_adjustment: "border-zinc-500/30 bg-zinc-500/10 text-zinc-700",
};

const FILTERS = [
  { value: "all", label: "All" },
  { value: "deposit", label: "Deposits" },
  { value: "withdrawal", label: "Withdrawals" },
  { value: "game_topup", label: "Top-ups" },
  { value: "game_transfer", label: "Transfers" },
  { value: "credit_pull", label: "Credit pulls" },
];

const PAGE = 25;

/**
 * One player's full audit trail, served page by page.
 *
 * Read from /api/history rather than the store: the store caps each collection
 * at a few hundred rows across all players, so a long-standing player's older
 * activity simply isn't in it. This pages through the whole table for one
 * player, and stays inside the caller's company scope server-side.
 */
export function PlayerTransactionsTab({ playerId }: { playerId: number }) {
  const [type, setType] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const userName = useStore((s) => s.userName);

  // The result is stamped with the request it answered, so "still loading" is
  // derived from a key mismatch rather than a synchronous reset in the effect.
  const requestKey = `${playerId}:${type}:${from}:${to}`;
  const [result, setResult] = useState<{
    key: string;
    entries: Entry[];
    total: number;
    error: string | null;
  }>({ key: "", entries: [], total: 0, error: null });

  const load = useCallback(
    async (offset: number, filter: string, fromDate: string, toDate: string) => {
      const params = new URLSearchParams({
        player_id: String(playerId),
        limit: String(PAGE),
        offset: String(offset),
      });
      if (filter !== "all") params.set("type", filter);
      // Filtered server-side — the range has to apply to the whole history,
      // not just the page already fetched.
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      const res = await fetch(`/api/history?${params}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data as { entries: Entry[]; total: number };
    },
    [playerId],
  );

  // Refetch from the top whenever the player or the type filter changes.
  useEffect(() => {
    let cancelled = false;
    load(0, type, from, to)
      .then((d) => {
        if (cancelled) return;
        setResult({
          key: requestKey,
          entries: d.entries,
          total: d.total,
          error: null,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setResult({
          key: requestKey,
          entries: [],
          total: 0,
          error: e instanceof Error ? e.message : "Could not load history",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [load, type, from, to, requestKey]);

  const loading = result.key !== requestKey;
  const entries = loading ? [] : result.entries;
  const total = loading ? 0 : result.total;
  const error = loading ? null : result.error;

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await load(entries.length, type, from, to);
      setResult((prev) => ({
        ...prev,
        entries: [...prev.entries, ...d.entries],
        total: d.total,
      }));
    } catch (e) {
      setResult((prev) => ({
        ...prev,
        error: e instanceof Error ? e.message : "Could not load more",
      }));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setType(f.value)}
            className={cn(
              "inline-flex h-7 cursor-pointer items-center rounded-md px-2.5 text-[12px] font-medium transition-colors",
              type === f.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
        {!loading && (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {total} record{total === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">From</span>
        <input
          type="date"
          value={from}
          // An open-ended range is normal here, so neither end is required —
          // but "from" after "to" returns nothing and looks like a bug, so the
          // inputs bound each other.
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="From date"
          className="h-8 rounded-md border border-input bg-background px-2 text-[12px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
        />
        <span className="text-[11px] text-muted-foreground">to</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          aria-label="To date"
          className="h-8 rounded-md border border-input bg-background px-2 text-[12px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
        />
        {(from || to) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
            className="h-8 cursor-pointer text-[11px]"
          >
            <X className="h-3 w-3" />
            Clear
          </Button>
        )}
      </div>

      {error ? (
        <p className="py-6 text-center text-sm text-rose-600">{error}</p>
      ) : loading ? (
        <ListLoading label="Loading history…" />
      ) : entries.length === 0 ? (
        <div className="py-12 text-center">
          <Receipt className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {from || to
              ? "Nothing in that date range."
              : type === "all"
                ? "No activity recorded for this player yet."
                : "Nothing of this type for this player."}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap">
                    Date
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium">Game</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">
                    Amount
                  </th>
                  <th className="px-3 py-2 text-left font-medium">By</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.transaction_id} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap text-[12px]">
                      {formatDateTime(e.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
                          TYPE_STYLE[e.type] ??
                            "border-zinc-500/30 bg-zinc-500/10 text-zinc-700",
                        )}
                      >
                        {e.type.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[12px]">
                      {e.game_name ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {formatRM(e.amount)}
                    </td>
                    <td className="px-3 py-2 text-[12px] text-muted-foreground">
                      {/* No user_id means the bot or a sweep did it, not a person. */}
                      {e.user_name ?? (e.user_id ? userName(e.user_id) : "System")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {entries.length < total && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="cursor-pointer"
              >
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Load more ({total - entries.length} left)
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

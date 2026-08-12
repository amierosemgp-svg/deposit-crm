"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { formatDateTime } from "@/lib/format";
import { History, Loader2 } from "lucide-react";

type AuditRow = {
  audit_id: number;
  game_name: string;
  action: "added" | "updated" | "removed";
  old_game_username: string | null;
  new_game_username: string | null;
  changed_by_user_id: number | null;
  source: "bot" | "manual";
  created_at: string;
};

const ACTION_STYLE: Record<AuditRow["action"], string> = {
  added: "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300",
  updated: "border-amber-300 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300",
  removed: "border-rose-300 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300",
};

/**
 * Who changed which game account, and what the id was before. Loaded on demand
 * — it's only wanted when someone is already looking at a specific player.
 */
export function GameAccountHistory({
  playerId,
  refreshKey,
}: {
  playerId: number;
  /** Bump to reload after an edit in the parent. */
  refreshKey?: number;
}) {
  const userName = useStore((s) => s.userName);
  // Result is stamped with the request it answered, so "still loading" is
  // derived from a key mismatch rather than a synchronous reset in the effect.
  const requestKey = `${playerId}:${refreshKey ?? 0}`;
  const [result, setResult] = useState<{
    key: string;
    rows: AuditRow[] | null;
    error: string | null;
  }>({ key: "", rows: null, error: null });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/players/${playerId}/game-account-history`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setResult({
          key: requestKey,
          rows: d.error ? null : (d.history ?? []),
          error: d.error ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setResult({
            key: requestKey,
            rows: null,
            error: "Could not load history",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [playerId, requestKey]);

  const loading = result.key !== requestKey;
  const rows = loading ? null : result.rows;
  const error = loading ? null : result.error;

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        Game ID History
      </h3>

      {error ? (
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      ) : rows === null ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No changes recorded yet. Every future edit to a game account is logged
          here with who made it.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li
              key={r.audit_id}
              className="rounded-md border bg-card px-3 py-2 text-[12px]"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${ACTION_STYLE[r.action]}`}
                >
                  {r.action}
                </span>
                <span className="font-medium">{r.game_name}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {formatDateTime(r.created_at)}
                </span>
              </div>

              <div className="mt-1 font-mono text-[11px]">
                {r.action === "updated" ? (
                  <>
                    <span className="text-muted-foreground line-through">
                      {r.old_game_username}
                    </span>
                    <span className="mx-1.5 text-muted-foreground">→</span>
                    <span>{r.new_game_username}</span>
                  </>
                ) : r.action === "added" ? (
                  <span>{r.new_game_username}</span>
                ) : (
                  <span className="text-muted-foreground line-through">
                    {r.old_game_username}
                  </span>
                )}
              </div>

              <div className="mt-0.5 text-[11px] text-muted-foreground">
                by {r.source === "bot" ? "agent" : userName(r.changed_by_user_id)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

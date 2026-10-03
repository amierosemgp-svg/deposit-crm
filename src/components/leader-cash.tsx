"use client";

/**
 * A leader's cash on hand, as the screens show it: the opening amount entered
 * when they joined, and what the cash leader transfers since leave them holding
 * now. The figures come from GET /api/leader-cash (lib/leader-cash.ts).
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStore } from "@/lib/store";
import { formatDateTime, formatRM } from "@/lib/format";
import type { LeaderCash } from "@/lib/leader-cash";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";

export type { LeaderCash };

/** Every visible leader's cash, by user id; `reload` after anything that moves it. */
export function useLeaderCash() {
  const [cash, setCash] = useState<Map<number, LeaderCash>>(new Map());
  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/leader-cash");
      if (!res.ok) return;
      const data = (await res.json()) as { leader_cash?: LeaderCash[] };
      setCash(new Map((data.leader_cash ?? []).map((c) => [c.user_id, c])));
    } catch {
      // transient — the cards keep their last figures
    }
  }, []);
  useEffect(() => {
    // Fetch-on-mount; setState after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  return { cash, reload };
}

/** "Cash now: RM 1,200.00", or the amber "not set" when no opening was entered. */
export function cashLabel(c: LeaderCash | undefined, opening: number | null | undefined) {
  if (c?.cash_now != null) return `Cash now: ${formatRM(c.cash_now)}`;
  if (opening != null) return `Cash on hand: ${formatRM(opening)}`;
  return "Cash on hand: not set";
}

/** A typed cash amount, or null when it isn't a usable one (blank, negative). */
function parseCash(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * The breakdown behind one leader's figure — opening, each cash transfer since,
 * and the total — plus, for an admin, setting or correcting the opening.
 */
export function LeaderCashDialog({
  leader,
  cash,
  canEdit,
  onClose,
  onSaved,
}: {
  leader: Pick<User, "user_id" | "full_name" | "username" | "opening_cash">;
  cash: LeaderCash | undefined;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const updateUser = useStore((s) => s.updateUser);
  const userName = useStore((s) => s.userName);
  const opening = cash?.opening_cash ?? leader.opening_cash ?? null;
  const [editing, setEditing] = useState(opening == null && canEdit);
  const [raw, setRaw] = useState(opening == null ? "" : String(opening));
  const [busy, setBusy] = useState(false);
  const amount = parseCash(raw);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (amount === null || busy) return;
    setBusy(true);
    const res = await updateUser(leader.user_id, { opening_cash: amount });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error ?? "Failed to save cash on hand");
      return;
    }
    toast.success(`Opening cash for ${leader.full_name} set to ${formatRM(amount)}`);
    setEditing(false);
    onSaved();
  }

  const movements = cash?.movements ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>Cash on hand · {leader.full_name}</DialogTitle>
        <p className="-mt-2 text-xs text-muted-foreground">
          Opening cash, plus Clear Bank taken by them and transfers received from other
          leaders, minus transfers paid to other leaders — everything since the opening
          was entered. Cash expenses aren&apos;t counted.
        </p>

        {/* The equation, so the figure can be checked. */}
        <div className="grid grid-cols-4 gap-2 rounded-md border bg-muted/20 p-3 text-center tabular-nums">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Opening</div>
            <div className="text-sm font-medium">{opening == null ? "—" : formatRM(opening)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Received</div>
            <div className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
              +{formatRM(cash?.cash_in ?? 0)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Paid</div>
            <div className="text-sm font-medium text-red-600 dark:text-red-400">
              −{formatRM(cash?.cash_out ?? 0)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Cash now</div>
            <div className="text-sm font-semibold">
              {cash?.cash_now == null ? "—" : formatRM(cash.cash_now)}
            </div>
          </div>
        </div>

        {opening != null && cash?.opening_cash_at && (
          <p className="-mt-1 text-[11px] text-muted-foreground">
            Opening entered {formatDateTime(cash.opening_cash_at)}; transfers before then are
            already in it.
          </p>
        )}

        <div className="max-h-64 overflow-y-auto rounded-md border">
          {movements.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No Clear Bank or leader transfers{opening != null ? " since the opening" : ""}.
            </p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {movements.map((m) => (
                  <tr key={m.key} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                      {formatDateTime(m.at)}
                    </td>
                    <td className="px-3 py-1.5">
                      {m.kind === "clear_bank"
                        ? `Clear Bank · ${m.account_label}`
                        : m.counterparty_user_id === leader.user_id
                        ? m.amount > 0
                          ? "Own move into cash"
                          : "Own move out of cash"
                        : m.amount > 0
                          ? `From ${userName(m.counterparty_user_id)}`
                          : `To ${userName(m.counterparty_user_id)}`}
                      {m.note && <span className="text-muted-foreground"> · {m.note}</span>}
                    </td>
                    <td
                      className={cn(
                        "whitespace-nowrap px-3 py-1.5 text-right font-medium tabular-nums",
                        m.amount > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400",
                      )}
                    >
                      {m.amount > 0 ? "+" : "−"}
                      {formatRM(Math.abs(m.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {canEdit &&
          (editing ? (
            <form onSubmit={save} className="space-y-2">
              <Label htmlFor="leader-opening-cash">Opening cash on hand (RM)</Label>
              <div className="flex gap-2">
                <Input
                  id="leader-opening-cash"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  placeholder="0.00"
                  autoFocus
                />
                <Button type="submit" disabled={amount === null || busy} className="cursor-pointer">
                  {busy ? "Saving…" : "Save"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {opening == null
                  ? "The cash they hold today. Enter 0 if none."
                  : "Corrects the opening figure; its date stays the same. The change is logged."}
              </p>
            </form>
          ) : (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                onClick={() => setEditing(true)}
              >
                Correct opening cash
              </Button>
            </div>
          ))}
      </DialogContent>
    </Dialog>
  );
}

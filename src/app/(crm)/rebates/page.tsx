"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  CheckCircle2,
  Loader2,
  Percent,
  Play,
  RefreshCw,
  Settings2,
  Undo2,
  XCircle,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { formatRM, formatShortDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ListLoading } from "@/components/list-loading";
import { PlayerNameLink } from "@/components/player-name-link";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BONUS_PERIOD_LABELS, type BonusPlan } from "@/lib/types";
import type {
  RebateCutoffs,
  RebateLiveStatus,
  RebatePayoutView,
  RebatePlanData,
} from "@/lib/rebates";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DEFAULT_CUTOFFS: RebateCutoffs = {
  daily: { time: "00:00" },
  weekly: { weekday: 1, time: "00:00" },
  monthly: { day: 1, time: "00:00" },
};

const STATUS: Record<RebateLiveStatus, { label: string; className: string }> = {
  pending: {
    label: "Pending",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  queued: {
    label: "Queued",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  processing: {
    label: "Crediting…",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  credited: {
    label: "Credited",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  failed: {
    label: "Failed",
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  skipped: {
    label: "Skipped",
    className: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
  },
};

function StatusPill({ status }: { status: RebateLiveStatus }) {
  const s = STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}

function windowLabel(start: string, end: string): string {
  return `${formatShortDateTime(start)} → ${formatShortDateTime(end)}`;
}

async function call<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.error ?? `Request failed (${res.status})` };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

/**
 * Rebates — the daily / weekly / monthly lists. One tab per rebate plan;
 * "Generate" snapshots the window that just closed, and each row pays out as
 * a free credit to the game the player lost on.
 */
export default function RebatesPage() {
  const me = useStore((s) => s.me);
  const hydrated = useStore((s) => s.hydrated);
  const bonusPlans = useStore((s) => s.bonusPlans);
  const companyInScope = useStore((s) => s.companyInScope);
  const entityName = useStore((s) => s.entityName);
  const userName = useStore((s) => s.userName);
  const playerById = useStore((s) => s.playerById);
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);

  const isViewer = me?.role === "viewer";
  const isAdmin = me?.role === "super_admin";

  const plans = useMemo(
    () =>
      bonusPlans
        .filter(
          (p) =>
            p.type === "rebate" &&
            p.status === "active" &&
            (p.company_entity_id === null || companyInScope(p.company_entity_id)),
        )
        .sort((a, b) => {
          const order = { daily: 0, weekly: 1, monthly: 2 } as const;
          const pa = order[a.period ?? "daily"];
          const pb = order[b.period ?? "daily"];
          return pa - pb || a.name.localeCompare(b.name);
        }),
    [bonusPlans, companyInScope],
  );

  const [planId, setPlanId] = useState<number | null>(null);
  const activePlan: BonusPlan | undefined =
    plans.find((p) => p.plan_id === planId) ?? plans[0];

  const [windowStart, setWindowStart] = useState<string | null>(null);
  const [data, setData] = useState<RebatePlanData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!activePlan) return;
    const q = new URLSearchParams({ plan_id: String(activePlan.plan_id) });
    if (windowStart) q.set("window_start", windowStart);
    const res = await call<RebatePlanData>(`/api/rebates?${q}`);
    if (!res.ok) {
      setLoadError(res.error);
      return;
    }
    setLoadError(null);
    setData(res.data);
  }, [activePlan, windowStart]);

  useEffect(() => {
    let cancelled = false;
    if (!activePlan) return;
    void (async () => {
      const q = new URLSearchParams({ plan_id: String(activePlan.plan_id) });
      if (windowStart) q.set("window_start", windowStart);
      const res = await call<RebatePlanData>(`/api/rebates?${q}`);
      if (cancelled) return;
      if (!res.ok) setLoadError(res.error);
      else {
        setLoadError(null);
        setData(res.data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePlan, windowStart, version]);

  // Agent progress on queued credits shows up without a click.
  useEffect(() => {
    const t = setInterval(() => setVersion((v) => v + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const showing = data && activePlan && data.plan.plan_id === activePlan.plan_id ? data : null;
  const payouts = showing?.payouts ?? [];
  const pendingRows = payouts.filter((p) => p.live_status === "pending");
  const pendingTotal = pendingRows.reduce((s, p) => s + p.amount, 0);
  const listTotal = payouts
    .filter((p) => p.live_status !== "skipped")
    .reduce((s, p) => s + p.amount, 0);

  async function generate() {
    if (!activePlan || generating) return;
    setGenerating(true);
    const res = await call<RebatePlanData & { inserted: number; replaced: number }>(
      "/api/rebates/generate",
      { method: "POST", body: JSON.stringify({ plan_id: activePlan.plan_id }) },
    );
    setGenerating(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setWindowStart(res.data.selected_window_start);
    setData(res.data);
    toast.success(
      res.data.inserted === 0
        ? "No player lost money in that window — nothing to pay"
        : `${res.data.inserted} player${res.data.inserted === 1 ? "" : "s"} on the list${
            res.data.replaced ? " (previous unpaid list replaced)" : ""
          }`,
    );
  }

  // ---- pay ----

  type PayTarget = { rows: RebatePayoutView[]; single: boolean };
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);
  const [payGame, setPayGame] = useState("");
  const [paySkipBot, setPaySkipBot] = useState(false);

  function startPay(rows: RebatePayoutView[], single: boolean) {
    setPayTarget({ rows, single });
    setPayGame(single ? (rows[0]?.game_name ?? "") : "");
    setPaySkipBot(false);
  }

  async function confirmPay() {
    if (!payTarget || busy) return;
    setBusy(true);
    const body = {
      payouts: payTarget.rows.map((r) =>
        payTarget.single && payGame && payGame !== r.game_name
          ? { payout_id: r.payout_id, game_name: payGame }
          : { payout_id: r.payout_id },
      ),
      skip_bot: paySkipBot,
    };
    const res = await call<{ paid: number; total: number; failed: Array<{ payout_id: number; error: string }> }>(
      "/api/rebates/pay",
      { method: "POST", body: JSON.stringify(body) },
    );
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setPayTarget(null);
    if (res.data.paid) {
      toast.success(
        `${formatRM(res.data.total)} ${paySkipBot ? "credited" : "queued for the agent"} — ${res.data.paid} rebate${
          res.data.paid === 1 ? "" : "s"
        }`,
      );
    }
    for (const f of res.data.failed.slice(0, 3)) {
      const row = payouts.find((p) => p.payout_id === f.payout_id);
      toast.error(`${row?.username ?? `#${f.payout_id}`}: ${f.error}`);
    }
    if (res.data.failed.length > 3) {
      toast.error(`${res.data.failed.length - 3} more rows could not be paid`);
    }
    void load();
  }

  async function setRowStatus(row: RebatePayoutView, status: "pending" | "skipped") {
    if (busy) return;
    setBusy(true);
    const res = await call(`/api/rebates/${row.payout_id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    void load();
  }

  // ---- cutoffs ----

  const [editingCutoffs, setEditingCutoffs] = useState(false);
  const [cutoffForm, setCutoffForm] = useState<RebateCutoffs>(DEFAULT_CUTOFFS);
  const [savingCutoffs, setSavingCutoffs] = useState(false);

  function openCutoffs() {
    const c = showing?.cutoffs ?? settings.rebate_cutoffs ?? DEFAULT_CUTOFFS;
    setCutoffForm({
      daily: { ...c.daily },
      weekly: { ...c.weekly },
      monthly: { ...c.monthly },
    });
    setEditingCutoffs(true);
  }

  async function saveCutoffs() {
    if (savingCutoffs) return;
    const timeOk = (t: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t);
    if (!timeOk(cutoffForm.daily.time) || !timeOk(cutoffForm.weekly.time) || !timeOk(cutoffForm.monthly.time)) {
      toast.error("Times must be HH:MM");
      return;
    }
    if (cutoffForm.monthly.day < 1 || cutoffForm.monthly.day > 31) {
      toast.error("Monthly day must be 1–31");
      return;
    }
    setSavingCutoffs(true);
    const res = await updateSetting({ rebate_cutoffs: cutoffForm });
    setSavingCutoffs(false);
    if (!res.ok) {
      toast.error(res.error ?? "Could not save cutoffs");
      return;
    }
    setEditingCutoffs(false);
    setVersion((v) => v + 1);
  }

  // ---- render ----

  const payGames = payTarget?.single
    ? (playerById(payTarget.rows[0]?.player_id)?.game_accounts ?? []).map((g) => g.game_name)
    : [];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Rebates</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A share of what each player lost — deposits minus withdrawals — over the
            day, week or month. Generate the list once the window closes, then pay it.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={openCutoffs}
          className="shrink-0 cursor-pointer"
          title={isAdmin ? undefined : "Only the super admin changes cutoffs"}
        >
          <Settings2 className="h-3.5 w-3.5" />
          Cutoff times
        </Button>
      </div>

      {!hydrated ? (
        <Card className="p-5">
          <ListLoading label="Loading rebate plans…" />
        </Card>
      ) : plans.length === 0 ? (
        <Card className="p-10 text-center">
          <Percent className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No rebate plans yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Add a bonus of type Rebate on the{" "}
            <Link href="/bonuses" className="cursor-pointer underline">
              Bonuses
            </Link>{" "}
            page — daily, weekly or monthly — and it gets a tab here.
          </p>
        </Card>
      ) : (
        <>
          {/* One tab per plan, in period order. */}
          <div className="flex flex-wrap gap-1 border-b border-border">
            {plans.map((p) => {
              const active = p.plan_id === activePlan?.plan_id;
              return (
                <button
                  key={p.plan_id}
                  type="button"
                  onClick={() => {
                    setPlanId(p.plan_id);
                    setWindowStart(null);
                  }}
                  className={cn(
                    "-mb-px flex cursor-pointer items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors",
                    active
                      ? "border-emerald-600 font-medium text-foreground dark:border-emerald-400"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.name}
                  <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                    {BONUS_PERIOD_LABELS[p.period ?? "daily"]} · {p.percentage}%
                  </span>
                </button>
              );
            })}
          </div>

          {activePlan && (
            <Card className="space-y-4 p-5">
              {/* Window strip: what just closed, what's still open, generate. */}
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="space-y-1 text-sm">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Latest closed window · resets {showing?.cutoff_label ?? "…"}
                  </div>
                  <div className="font-medium tabular-nums">
                    {showing ? windowLabel(showing.latest_window.start, showing.latest_window.end) : "…"}
                    {showing?.latest_window.generated && (
                      <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-normal text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" /> generated
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    Current window {showing ? windowLabel(showing.current_window.start, showing.current_window.end) : "…"} — closes at the next cutoff
                  </div>
                  {activePlan.min_loss > 0 && (
                    <div className="text-xs text-muted-foreground">
                      Only losses of {formatRM(activePlan.min_loss)} or more qualify
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {showing && showing.windows.length > 0 && (
                    <Select
                      value={showing.selected_window_start ?? ""}
                      onValueChange={(v) => setWindowStart(v || null)}
                    >
                      <SelectTrigger className="w-[300px] cursor-pointer">
                        <SelectValue placeholder="Window" />
                      </SelectTrigger>
                      <SelectContent>
                        {showing.windows.map((w) => (
                          <SelectItem key={w.window_start} value={w.window_start} className="cursor-pointer">
                            {windowLabel(w.window_start, w.window_end)} · {w.rows} row{w.rows === 1 ? "" : "s"}
                            {w.paid ? ` · ${w.paid} paid` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {!isViewer && (
                    <Button
                      onClick={generate}
                      disabled={generating || !showing}
                      className="cursor-pointer"
                      title={
                        showing?.latest_window.generated
                          ? "Re-run for the latest closed window (only while nothing in it is paid)"
                          : "Build the list for the latest closed window"
                      }
                    >
                      {generating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      {showing?.latest_window.generated ? "Regenerate latest list" : "Generate latest list"}
                    </Button>
                  )}
                </div>
              </div>

              {loadError ? (
                <p className="text-sm text-red-600">{loadError}</p>
              ) : !showing ? (
                <ListLoading label="Loading…" />
              ) : payouts.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  {showing.windows.length === 0
                    ? "No list generated yet — generate the latest closed window to see who qualifies."
                    : "No player lost money in this window."}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div className="text-muted-foreground">
                      Showing{" "}
                      <span className="font-medium text-foreground tabular-nums">
                        {windowLabel(payouts[0].window_start, payouts[0].window_end)}
                      </span>
                      {" · "}
                      {payouts.length} player{payouts.length === 1 ? "" : "s"} · list total{" "}
                      <span className="font-medium text-foreground">{formatRM(listTotal)}</span>
                    </div>
                    {!isViewer && pendingRows.length > 0 && (
                      <Button
                        size="sm"
                        onClick={() => startPay(pendingRows, false)}
                        disabled={busy}
                        className="cursor-pointer"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Pay all pending · {pendingRows.length} · {formatRM(pendingTotal)}
                      </Button>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="px-2 py-2 font-medium">Member</th>
                          <th className="px-2 py-2 font-medium">Company</th>
                          <th className="px-2 py-2 font-medium">Credit to</th>
                          <th className="px-2 py-2 text-right font-medium">Deposits</th>
                          <th className="px-2 py-2 text-right font-medium">Withdrawals</th>
                          <th className="px-2 py-2 text-right font-medium">Net loss</th>
                          <th className="px-2 py-2 text-right font-medium">%</th>
                          <th className="px-2 py-2 text-right font-medium">Rebate</th>
                          <th className="px-2 py-2 font-medium">Status</th>
                          <th className="px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {payouts.map((r) => {
                          const skipped = r.live_status === "skipped";
                          return (
                            <tr
                              key={r.payout_id}
                              className={cn("border-b last:border-b-0", skipped && "opacity-55")}
                            >
                              <td className="px-2 py-2">
                                <div className="font-medium">
                                  <PlayerNameLink playerId={r.player_id}>{r.username}</PlayerNameLink>
                                </div>
                                <div className="text-[11px] text-muted-foreground">{r.full_name}</div>
                              </td>
                              <td className="px-2 py-2 text-xs text-muted-foreground">
                                {entityName(r.company_entity_id)}
                              </td>
                              <td className="px-2 py-2">
                                {r.game_name ? (
                                  <>
                                    <div>{r.game_name}</div>
                                    <div className="text-[11px] text-muted-foreground">{r.game_username}</div>
                                  </>
                                ) : (
                                  <span className="text-xs text-red-600">No game account</span>
                                )}
                              </td>
                              <td className="px-2 py-2 text-right tabular-nums">{formatRM(r.deposits_total)}</td>
                              <td className="px-2 py-2 text-right tabular-nums">{formatRM(r.withdrawals_total)}</td>
                              <td className="px-2 py-2 text-right font-medium tabular-nums">{formatRM(r.net_loss)}</td>
                              <td className="px-2 py-2 text-right tabular-nums">{r.percentage}%</td>
                              <td className="px-2 py-2 text-right font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                                {formatRM(r.amount)}
                              </td>
                              <td className="px-2 py-2">
                                <StatusPill status={r.live_status} />
                                {r.paid_at && (
                                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                                    {formatShortDateTime(r.paid_at)} · {userName(r.paid_by_user_id)}
                                  </div>
                                )}
                              </td>
                              <td className="px-2 py-2 text-right whitespace-nowrap">
                                {!isViewer && r.live_status === "pending" && (
                                  <>
                                    <Button
                                      size="xs"
                                      onClick={() => startPay([r], true)}
                                      disabled={busy}
                                      className="cursor-pointer"
                                    >
                                      Pay
                                    </Button>
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      onClick={() => setRowStatus(r, "skipped")}
                                      disabled={busy}
                                      className="ml-1 cursor-pointer text-muted-foreground"
                                      title="Leave this one out"
                                    >
                                      <XCircle className="h-3.5 w-3.5" />
                                    </Button>
                                  </>
                                )}
                                {!isViewer && skipped && (
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => setRowStatus(r, "pending")}
                                    disabled={busy}
                                    className="cursor-pointer"
                                    title="Put it back on the list"
                                  >
                                    <Undo2 className="h-3.5 w-3.5" />
                                    Unskip
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Card>
          )}
        </>
      )}

      {/* Pay one / pay all */}
      <Dialog open={payTarget !== null} onOpenChange={(o) => !o && !busy && setPayTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {payTarget && (
            <>
              <DialogTitle>
                {payTarget.single
                  ? `Pay ${formatRM(payTarget.rows[0].amount)} to ${payTarget.rows[0].username}`
                  : `Pay ${payTarget.rows.length} rebates · ${formatRM(
                      payTarget.rows.reduce((s, r) => s + r.amount, 0),
                    )}`}
              </DialogTitle>
              <DialogDescription>
                {payTarget.single
                  ? "The rebate goes in as a free credit to the game below."
                  : "Each rebate goes in as a free credit to the game the player lost on. Rows without a game account are reported back and stay pending."}
              </DialogDescription>
              <div className="space-y-4 py-2">
                {payTarget.single && (
                  <div className="space-y-1.5">
                    <Label>Game</Label>
                    <Select value={payGame} onValueChange={(v) => setPayGame(v ?? "")}>
                      <SelectTrigger className="w-full cursor-pointer">
                        <SelectValue placeholder="Pick a game" />
                      </SelectTrigger>
                      <SelectContent>
                        {payGames.map((g) => (
                          <SelectItem key={g} value={g} className="cursor-pointer">
                            {g}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {payGames.length === 0 && (
                      <p className="text-xs text-red-600">This player has no game account linked.</p>
                    )}
                  </div>
                )}
                <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
                  <span>
                    <span className="font-medium">Already credited by hand</span>
                    <span className="block text-xs text-muted-foreground">
                      On: book it now, the agent does nothing. Off: queue it for the agent to credit.
                    </span>
                  </span>
                  <Switch checked={paySkipBot} onCheckedChange={(v) => setPaySkipBot(!!v)} />
                </label>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPayTarget(null)} disabled={busy} className="cursor-pointer">
                  Cancel
                </Button>
                <Button
                  onClick={confirmPay}
                  disabled={busy || (payTarget.single && !payGame)}
                  className="cursor-pointer"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {paySkipBot ? "Book as credited" : "Queue for the agent"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Cutoff times */}
      <Dialog open={editingCutoffs} onOpenChange={(o) => !o && !savingCutoffs && setEditingCutoffs(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Cutoff times</DialogTitle>
          <DialogDescription>
            When a rebate day, week and month roll over, in Malaysia time. A window runs from
            one cutoff to the next; &quot;Generate&quot; builds the window that most recently closed.
            {!isAdmin && " Only the super admin can change these."}
          </DialogDescription>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-[88px_1fr] items-center gap-3">
              <Label>Daily</Label>
              <Input
                type="time"
                value={cutoffForm.daily.time}
                disabled={!isAdmin}
                onChange={(e) => setCutoffForm((f) => ({ ...f, daily: { time: e.target.value } }))}
              />
              <Label>Weekly</Label>
              <div className="flex gap-2">
                <Select
                  value={String(cutoffForm.weekly.weekday)}
                  onValueChange={(v) =>
                    setCutoffForm((f) => ({ ...f, weekly: { ...f.weekly, weekday: Number(v) } }))
                  }
                  disabled={!isAdmin}
                >
                  <SelectTrigger className="w-[150px] cursor-pointer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((d, i) => (
                      <SelectItem key={d} value={String(i)} className="cursor-pointer">
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="time"
                  value={cutoffForm.weekly.time}
                  disabled={!isAdmin}
                  onChange={(e) =>
                    setCutoffForm((f) => ({ ...f, weekly: { ...f.weekly, time: e.target.value } }))
                  }
                />
              </div>
              <Label>Monthly</Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Day</span>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={cutoffForm.monthly.day}
                  disabled={!isAdmin}
                  className="w-20"
                  onChange={(e) =>
                    setCutoffForm((f) => ({
                      ...f,
                      monthly: { ...f.monthly, day: Number(e.target.value) },
                    }))
                  }
                />
                <Input
                  type="time"
                  value={cutoffForm.monthly.time}
                  disabled={!isAdmin}
                  onChange={(e) =>
                    setCutoffForm((f) => ({ ...f, monthly: { ...f.monthly, time: e.target.value } }))
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              A monthly day past the month&apos;s end (the 31st in April) falls on the month&apos;s last day.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditingCutoffs(false)} className="cursor-pointer">
              {isAdmin ? "Cancel" : "Close"}
            </Button>
            {isAdmin && (
              <Button onClick={saveCutoffs} disabled={savingCutoffs} className="cursor-pointer">
                {savingCutoffs && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

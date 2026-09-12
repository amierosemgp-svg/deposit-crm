"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ChevronDown,
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
  RebateWindowRow,
} from "@/lib/rebates";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Base UI's Select shows the raw value in its trigger unless given the labels.
const WEEKDAY_ITEMS = WEEKDAYS.map((d, i) => ({ value: String(i), label: d }));

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

function Pill({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
    >
      {label}
    </span>
  );
}

function windowLabel(start: string, end: string): string {
  return `${formatShortDateTime(start)} → ${formatShortDateTime(end)}`;
}

/** The one-line state of a window, for its collapsed row. */
function windowPill(w: RebateWindowRow) {
  if (!w.generated) return <Pill label="Not generated" className={STATUS.skipped.className} />;
  if (w.rows === 0) return <Pill label="No losses" className={STATUS.skipped.className} />;
  if (w.pending > 0) return <Pill label={`${w.pending} pending`} className={STATUS.pending.className} />;
  if (w.paid > 0) return <Pill label={w.paid === w.rows ? "All paid" : `${w.paid} paid`} className={STATUS.credited.className} />;
  return <Pill label="All skipped" className={STATUS.skipped.className} />;
}

async function call<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
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
 * Rebates — the daily / weekly / monthly lists. One tab per rebate plan; the
 * tab is a list of closed windows, newest first, each row a summary that
 * expands into that window's payouts. Any closed window can be generated
 * from its row (a day nobody ran), and each payout goes out as a free credit
 * to the game the player lost on.
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
          return (
            order[a.period ?? "daily"] - order[b.period ?? "daily"] || a.name.localeCompare(b.name)
          );
        }),
    [bonusPlans, companyInScope],
  );

  const [planId, setPlanId] = useState<number | null>(null);
  const activePlan: BonusPlan | undefined = plans.find((p) => p.plan_id === planId) ?? plans[0];
  const activePlanId = activePlan?.plan_id ?? null;

  const [data, setData] = useState<RebatePlanData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Expanded windows (by start) and the payouts loaded for each.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [payoutsByWindow, setPayoutsByWindow] = useState<Record<string, RebatePayoutView[]>>({});
  const [loadingWindow, setLoadingWindow] = useState<string | null>(null);
  const [generatingWindow, setGeneratingWindow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  const loadPlan = useCallback(async (id: number) => {
    const res = await call<RebatePlanData>(`/api/rebates?plan_id=${id}`);
    if (!res.ok) {
      setLoadError(res.error);
      return null;
    }
    setLoadError(null);
    setData(res.data);
    return res.data;
  }, []);

  const loadWindow = useCallback(async (id: number, start: string) => {
    const q = new URLSearchParams({ plan_id: String(id), window_start: start });
    const res = await call<RebatePlanData>(`/api/rebates?${q}`);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setData(res.data);
    if (res.data.payouts_for) {
      const key = res.data.payouts_for;
      const rows = res.data.payouts;
      setPayoutsByWindow((m) => ({ ...m, [key]: rows }));
    }
  }, []);

  // Tab change: fresh list, the newest window open.
  useEffect(() => {
    if (activePlanId === null) return;
    let cancelled = false;
    void (async () => {
      const d = await loadPlan(activePlanId);
      if (cancelled || !d) return;
      const first = d.windows[0];
      if (first) {
        setExpanded(new Set([first.start]));
        if (first.generated) await loadWindow(activePlanId, first.start);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePlanId, loadPlan, loadWindow]);

  // Agent progress on queued credits shows up without a click: refresh the
  // list and every open window every 15 s.
  useEffect(() => {
    const t = setInterval(() => setVersion((v) => v + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (version === 0 || activePlanId === null) return;
    void (async () => {
      const d = await loadPlan(activePlanId);
      if (!d) return;
      for (const start of expanded) {
        const w = d.windows.find((x) => x.start === start);
        if (w?.generated) await loadWindow(activePlanId, start);
      }
    })();
    // Only the tick drives this; the rest is read at tick time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const refreshWindow = useCallback(
    async (start: string) => {
      if (activePlanId === null) return;
      await loadWindow(activePlanId, start);
    },
    [activePlanId, loadWindow],
  );

  async function toggle(w: RebateWindowRow) {
    const next = new Set(expanded);
    if (next.has(w.start)) {
      next.delete(w.start);
      setExpanded(next);
      return;
    }
    next.add(w.start);
    setExpanded(next);
    if (w.generated && !payoutsByWindow[w.start] && activePlanId !== null) {
      setLoadingWindow(w.start);
      await loadWindow(activePlanId, w.start);
      setLoadingWindow(null);
    }
  }

  async function generate(w: RebateWindowRow) {
    if (!activePlan || generatingWindow) return;
    setGeneratingWindow(w.start);
    const res = await call<RebatePlanData & { inserted: number; replaced: number }>(
      "/api/rebates/generate",
      {
        method: "POST",
        body: JSON.stringify({ plan_id: activePlan.plan_id, window_end: w.end }),
      },
    );
    setGeneratingWindow(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setData(res.data);
    if (res.data.payouts_for) {
      const key = res.data.payouts_for;
      const rows = res.data.payouts;
      setPayoutsByWindow((m) => ({ ...m, [key]: rows }));
    }
    setExpanded((s) => new Set(s).add(w.start));
    toast.success(
      res.data.inserted === 0
        ? "No player lost money in that window — nothing to pay"
        : `${res.data.inserted} player${res.data.inserted === 1 ? "" : "s"} on the list${
            res.data.replaced ? " (previous unpaid list replaced)" : ""
          }`,
    );
  }

  // ---- pay ----

  type PayTarget = { rows: RebatePayoutView[]; single: boolean; windowStart: string };
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);
  const [payGame, setPayGame] = useState("");
  const [paySkipBot, setPaySkipBot] = useState(false);

  function startPay(rows: RebatePayoutView[], single: boolean, windowStart: string) {
    setPayTarget({ rows, single, windowStart });
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
    const res = await call<{
      paid: number;
      total: number;
      failed: Array<{ payout_id: number; error: string }>;
    }>("/api/rebates/pay", { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    const target = payTarget;
    setPayTarget(null);
    if (res.data.paid) {
      toast.success(
        `${formatRM(res.data.total)} ${paySkipBot ? "credited" : "queued for the agent"} — ${
          res.data.paid
        } rebate${res.data.paid === 1 ? "" : "s"}`,
      );
    }
    for (const f of res.data.failed.slice(0, 3)) {
      const row = target.rows.find((p) => p.payout_id === f.payout_id);
      toast.error(`${row?.username ?? `#${f.payout_id}`}: ${f.error}`);
    }
    if (res.data.failed.length > 3) {
      toast.error(`${res.data.failed.length - 3} more rows could not be paid`);
    }
    void refreshWindow(target.windowStart);
  }

  async function setRowStatus(row: RebatePayoutView, status: "pending" | "skipped", windowStart: string) {
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
    void refreshWindow(windowStart);
  }

  // ---- cutoffs ----

  const [editingCutoffs, setEditingCutoffs] = useState(false);
  const [cutoffForm, setCutoffForm] = useState<RebateCutoffs>(DEFAULT_CUTOFFS);
  const [savingCutoffs, setSavingCutoffs] = useState(false);

  function openCutoffs() {
    const c = data?.cutoffs ?? settings.rebate_cutoffs ?? DEFAULT_CUTOFFS;
    setCutoffForm({ daily: { ...c.daily }, weekly: { ...c.weekly }, monthly: { ...c.monthly } });
    setEditingCutoffs(true);
  }

  async function saveCutoffs() {
    if (savingCutoffs) return;
    const timeOk = (t: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t);
    if (
      !timeOk(cutoffForm.daily.time) ||
      !timeOk(cutoffForm.weekly.time) ||
      !timeOk(cutoffForm.monthly.time)
    ) {
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
    // New boundaries: the window list is different now.
    if (activePlanId !== null) void loadPlan(activePlanId);
  }

  // ---- render ----

  const showing = data && activePlan && data.plan.plan_id === activePlan.plan_id ? data : null;
  const payGames = payTarget?.single
    ? (playerById(payTarget.rows[0]?.player_id)?.game_accounts ?? []).map((g) => g.game_name)
    : [];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Rebates</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A share of what each player lost — deposits minus withdrawals — over the day,
            week or month. Each row is one window: generate its list once it closes, then pay it.
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
                    if (p.plan_id === activePlan?.plan_id) return;
                    // A fresh tab: drop the old list so nothing stale shows
                    // while the new one loads (the effect does the loading).
                    setData(null);
                    setExpanded(new Set());
                    setPayoutsByWindow({});
                    setPlanId(p.plan_id);
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
            <Card className="p-0">
              {/* Plan strip: the cutoff rule and the window still open. */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 text-xs text-muted-foreground">
                <div>
                  Resets <span className="font-medium text-foreground">{showing?.cutoff_label ?? "…"}</span>
                  {activePlan.min_loss > 0 && (
                    <> · only losses of {formatRM(activePlan.min_loss)} or more qualify</>
                  )}
                </div>
                <div className="tabular-nums">
                  Current window{" "}
                  {showing ? windowLabel(showing.current_window.start, showing.current_window.end) : "…"} —
                  closes at the next cutoff
                </div>
              </div>

              {loadError ? (
                <p className="px-5 py-4 text-sm text-red-600">{loadError}</p>
              ) : !showing ? (
                <div className="px-5 py-4">
                  <ListLoading label="Loading…" />
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {showing.windows.map((w) => {
                    const open = expanded.has(w.start);
                    const rows = payoutsByWindow[w.start];
                    const pendingRows = (rows ?? []).filter((r) => r.live_status === "pending");
                    const pendingTotal = pendingRows.reduce((s, r) => s + r.amount, 0);
                    const isGenerating = generatingWindow === w.start;
                    return (
                      <li key={w.start}>
                        {/* Summary row — the whole line toggles; buttons stop the click. */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => void toggle(w)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void toggle(w);
                            }
                          }}
                          className={cn(
                            "flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-sm hover:bg-muted/40",
                            open && "bg-muted/30",
                          )}
                        >
                          <ChevronDown
                            className={cn(
                              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                              open && "rotate-180",
                            )}
                          />
                          <span className="min-w-[300px] font-medium tabular-nums">
                            {windowLabel(w.start, w.end)}
                          </span>
                          {windowPill(w)}
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {w.generated ? (
                              <>
                                {w.rows} player{w.rows === 1 ? "" : "s"}
                                {w.paid ? ` · ${w.paid} paid` : ""}
                                {w.skipped ? ` · ${w.skipped} skipped` : ""}
                                {" · "}
                                <span className="font-medium text-foreground">{formatRM(w.total)}</span>
                                {w.generated_at ? ` · generated ${formatShortDateTime(w.generated_at)}` : ""}
                              </>
                            ) : (
                              "no list yet"
                            )}
                          </span>
                          <span className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            {!isViewer && w.generated && pendingRows.length > 0 && open && (
                              <Button
                                size="xs"
                                onClick={() => startPay(pendingRows, false, w.start)}
                                disabled={busy}
                                className="cursor-pointer"
                              >
                                <Play className="h-3 w-3" />
                                Pay all · {pendingRows.length} · {formatRM(pendingTotal)}
                              </Button>
                            )}
                            {!isViewer && (
                              <Button
                                size="xs"
                                variant={w.generated ? "outline" : "default"}
                                onClick={() => void generate(w)}
                                disabled={isGenerating || w.frozen}
                                className="cursor-pointer"
                                title={
                                  w.frozen
                                    ? "Something in this window is paid — the list is frozen"
                                    : w.generated
                                      ? "Re-run this window; the unpaid list is replaced"
                                      : "Build the list for this window"
                                }
                              >
                                {isGenerating ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3 w-3" />
                                )}
                                {w.generated ? "Regenerate" : "Generate"}
                              </Button>
                            )}
                          </span>
                        </div>

                        {open && (
                          <div className="border-t border-border/60 bg-background px-5 py-3">
                            {!w.generated ? (
                              <p className="py-3 text-sm text-muted-foreground">
                                No list for this window yet — Generate measures each player&apos;s loss
                                between the two cutoffs and lists who qualifies.
                              </p>
                            ) : loadingWindow === w.start || !rows ? (
                              <ListLoading label="Loading payouts…" />
                            ) : rows.length === 0 ? (
                              <p className="py-3 text-sm text-muted-foreground">
                                No player lost money in this window.
                              </p>
                            ) : (
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
                                    {rows.map((r) => {
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
                                                <div className="text-[11px] text-muted-foreground">
                                                  {r.game_username}
                                                </div>
                                              </>
                                            ) : (
                                              <span className="text-xs text-red-600">No game account</span>
                                            )}
                                          </td>
                                          <td className="px-2 py-2 text-right tabular-nums">
                                            {formatRM(r.deposits_total)}
                                          </td>
                                          <td className="px-2 py-2 text-right tabular-nums">
                                            {formatRM(r.withdrawals_total)}
                                          </td>
                                          <td className="px-2 py-2 text-right font-medium tabular-nums">
                                            {formatRM(r.net_loss)}
                                          </td>
                                          <td className="px-2 py-2 text-right tabular-nums">{r.percentage}%</td>
                                          <td className="px-2 py-2 text-right font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                                            {formatRM(r.amount)}
                                          </td>
                                          <td className="px-2 py-2">
                                            <Pill {...STATUS[r.live_status]} />
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
                                                  onClick={() => startPay([r], true, w.start)}
                                                  disabled={busy}
                                                  className="cursor-pointer"
                                                >
                                                  Pay
                                                </Button>
                                                <Button
                                                  size="xs"
                                                  variant="ghost"
                                                  onClick={() => setRowStatus(r, "skipped", w.start)}
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
                                                onClick={() => setRowStatus(r, "pending", w.start)}
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
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
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
                <Button
                  variant="outline"
                  onClick={() => setPayTarget(null)}
                  disabled={busy}
                  className="cursor-pointer"
                >
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
      <Dialog
        open={editingCutoffs}
        onOpenChange={(o) => !o && !savingCutoffs && setEditingCutoffs(false)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Cutoff times</DialogTitle>
          <DialogDescription>
            When a rebate day, week and month roll over, in Malaysia time. A window runs from
            one cutoff to the next; &quot;Generate&quot; measures the loss between them.
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
                  items={WEEKDAY_ITEMS}
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
            <Button
              variant="outline"
              onClick={() => setEditingCutoffs(false)}
              className="cursor-pointer"
            >
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

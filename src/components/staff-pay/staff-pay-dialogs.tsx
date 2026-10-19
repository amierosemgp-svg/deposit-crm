"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Clock, Gift, Loader2, ShieldAlert } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStore } from "@/lib/store";
import { formatClock, formatRM } from "@/lib/format";
import { PickSelect } from "./pick-select";
import {
  monthLabel,
  PENALTY_SOURCE_LABEL,
  send,
  type PenaltySource,
  type StaffRow,
} from "./use-staff-pay";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Today in business time, for a date input. */
function todayMyt(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function useStaffItems(staff: StaffRow[], exclude?: number) {
  const entityName = useStore((s) => s.entityName);
  return useMemo(
    () =>
      staff
        .filter((s) => s.status === "active" && s.user_id !== exclude)
        .sort((a, b) => a.full_name.localeCompare(b.full_name))
        .map((s) => ({ value: String(s.user_id), label: `${s.full_name} · ${entityName(s.company_entity_id)}` })),
    [staff, entityName, exclude],
  );
}

// ---------- bonus / deduction ----------

export function AdjustmentModal({
  open,
  onOpenChange,
  staff,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  staff: StaffRow[];
  onDone: () => void;
}) {
  const staffItems = useStaffItems(staff);
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState<"bonus" | "deduction">("bonus");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(todayMyt());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUserId("");
    setKind("bonus");
    setAmount("");
    setReason("");
    setDate(todayMyt());
  }, [open]);

  const amt = Number(amount) || 0;
  const validation = !userId
    ? "Pick a CS"
    : amt <= 0
      ? "Enter an amount"
      : !reason.trim()
        ? "Say what it's for"
        : null;

  async function save() {
    if (validation || busy) return;
    setBusy(true);
    const res = await send("/api/salary-adjustments", "POST", {
      user_id: Number(userId),
      kind,
      amount: amt,
      reason: reason.trim(),
      occurred_at: `${date}T12:00:00+08:00`,
    });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(`${kind === "bonus" ? "Bonus" : "Deduction"} of ${formatRM(amt)} added to the next salary`);
    onDone();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="flex items-center gap-2">
          <Gift className="h-4 w-4 text-muted-foreground" />
          Bonus or deduction
        </DialogTitle>
        <DialogDescription>
          Goes on their next salary automatically. A mistake that cost credit is a staff penalty
          instead.
        </DialogDescription>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>CS</Label>
            <PickSelect value={userId} onChange={setUserId} items={staffItems} placeholder="Who" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <PickSelect
                value={kind}
                onChange={(v) => setKind(v as "bonus" | "deduction")}
                items={[
                  { value: "bonus", label: "Bonus (+)" },
                  { value: "deduction", label: "Deduction (−)" },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Amount (RM)</Label>
              <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="what it's for" />
          </div>
          <div className="space-y-1.5">
            <Label>Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <Footer validation={validation} busy={busy} onCancel={() => onOpenChange(false)} onSave={save} label="Add" />
      </DialogContent>
    </Dialog>
  );
}

// ---------- staff penalty ----------

type SourceLookup = {
  user_id: number | null;
  credit_injected: number;
  player_id: number | null;
  player_label: string | null;
  occurred_at: string;
};

/**
 * A CS's share of credit the house lost through their mistake.
 *
 * Name the deposit (or free credit) and the CS who handled it, the amount
 * credited (deposit plus bonus) and the player fill themselves in. What the
 * CS had to key is what was clawed back; the rest is arithmetic.
 */
export function PenaltyModal({
  open,
  onOpenChange,
  staff,
  sharePct,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  staff: StaffRow[];
  sharePct: number;
  onDone: () => void;
}) {
  const me = useStore((s) => s.me);
  // A CS can't record one against themselves (the server refuses it too).
  const staffItems = useStaffItems(staff, me?.role === "cs_agent" ? me.user_id : undefined);

  const [source, setSource] = useState<PenaltySource>("deposit");
  const [sourceId, setSourceId] = useState("");
  const [lookup, setLookup] = useState<SourceLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [userId, setUserId] = useState("");
  const [injected, setInjected] = useState("");
  const [retrieved, setRetrieved] = useState("0");
  const [share, setShare] = useState(String(sharePct));
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(todayMyt());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSource("deposit");
    setSourceId("");
    setLookup(null);
    setLookupError(null);
    setUserId("");
    setInjected("");
    setRetrieved("0");
    setShare(String(sharePct));
    setReason("");
    setDate(todayMyt());
  }, [open, sharePct]);

  const canLookup = source === "deposit" || source === "free_credit";

  async function find() {
    if (!canLookup || !Number(sourceId)) return;
    setLooking(true);
    setLookupError(null);
    try {
      const res = await fetch(`/api/staff-penalties/source?type=${source}&id=${Number(sourceId)}`);
      const d = (await res.json().catch(() => null)) as { source?: SourceLookup; error?: string } | null;
      if (!res.ok || !d?.source) {
        setLookup(null);
        setLookupError(d?.error ?? "Not found");
        return;
      }
      setLookup(d.source);
      setInjected(String(d.source.credit_injected));
      if (d.source.user_id && staffItems.some((s) => s.value === String(d.source!.user_id))) {
        setUserId(String(d.source.user_id));
      }
      setDate(new Date(new Date(d.source.occurred_at).getTime() + 8 * 3600_000).toISOString().slice(0, 10));
    } finally {
      setLooking(false);
    }
  }

  const inj = Number(injected) || 0;
  const ret = Number(retrieved) || 0;
  const pct = Number(share);
  const loss = round2(inj - ret);
  const amount = round2((loss * (Number.isFinite(pct) ? pct : 0)) / 100);

  const validation = !userId
    ? "Pick the CS"
    : inj <= 0
      ? "Enter what was credited"
      : ret < 0 || ret >= inj
        ? "Retrieved must be less than what was credited"
        : !Number.isFinite(pct) || pct < 0 || pct > 100
          ? "Share is a percent, 0–100"
          : !reason.trim()
            ? "Say what happened"
            : amount <= 0
              ? "Works out to RM 0"
              : null;

  async function save() {
    if (validation || busy) return;
    setBusy(true);
    const res = await send("/api/staff-penalties", "POST", {
      user_id: Number(userId),
      source_type: source,
      source_id: Number(sourceId) || null,
      player_id: lookup?.player_id ?? null,
      occurred_at: `${date}T12:00:00+08:00`,
      credit_injected: inj,
      credit_retrieved: ret,
      share_pct: pct,
      reason: reason.trim(),
    });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(`Staff penalty of ${formatRM(amount)} recorded — it comes off the next salary`);
    onDone();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          Staff penalty
        </DialogTitle>
        <DialogDescription>
          Credit given by mistake and spent before it could be taken back. The CS bears{" "}
          {sharePct}% of what was lost, deducted from their next salary.
        </DialogDescription>

        <div className="space-y-4 py-1">
          <div className="grid grid-cols-[150px_1fr_auto] items-end gap-2">
            <div className="space-y-1.5">
              <Label>Mistake on</Label>
              <PickSelect
                value={source}
                onChange={(v) => {
                  setSource(v as PenaltySource);
                  setLookup(null);
                  setLookupError(null);
                }}
                items={(Object.keys(PENALTY_SOURCE_LABEL) as PenaltySource[]).map((k) => ({
                  value: k,
                  label: PENALTY_SOURCE_LABEL[k],
                }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{PENALTY_SOURCE_LABEL[source]} ID {canLookup ? "" : "(optional)"}</Label>
              <Input
                inputMode="numeric"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && void find()}
                placeholder={canLookup ? "e.g. 12163" : "if there is one"}
              />
            </div>
            {canLookup && (
              <Button
                variant="outline"
                className="cursor-pointer"
                disabled={!sourceId || looking}
                onClick={() => void find()}
              >
                {looking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Look up"}
              </Button>
            )}
          </div>
          {lookupError && <p className="text-xs text-red-600 dark:text-red-400">{lookupError}</p>}
          {lookup?.player_label && (
            <p className="text-xs text-muted-foreground">
              Player <span className="font-medium text-foreground">{lookup.player_label}</span> — credited{" "}
              {formatRM(lookup.credit_injected)}
            </p>
          )}

          <div className="space-y-1.5">
            <Label>CS who made the mistake</Label>
            <PickSelect value={userId} onChange={setUserId} items={staffItems} placeholder="Who" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Credited (RM)</Label>
              <Input type="number" min={0} step="0.01" value={injected} onChange={(e) => setInjected(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Retrieved (RM)</Label>
              <Input type="number" min={0} step="0.01" value={retrieved} onChange={(e) => setRetrieved(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>CS share (%)</Label>
              <Input type="number" min={0} max={100} step="1" value={share} onChange={(e) => setShare(e.target.value)} />
            </div>
          </div>

          <div className="flex items-baseline justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              Lost {formatRM(Math.max(loss, 0))} × {Number.isFinite(pct) ? pct : 0}%
            </span>
            <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">
              −{formatRM(Math.max(amount, 0))}
            </span>
          </div>

          <div className="grid grid-cols-[1fr_150px] gap-3">
            <div className="space-y-1.5">
              <Label>What happened</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. approved a fake receipt" />
            </div>
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
        </div>
        <Footer validation={validation} busy={busy} onCancel={() => onOpenChange(false)} onSave={save} label="Record penalty" />
      </DialogContent>
    </Dialog>
  );
}

// ---------- hours, day by day ----------

type HoursData = {
  full_name: string;
  worked: { hours: number; days: number; daily: Record<string, number> };
  sessions: Array<{ started_at: string; last_active_at: string }>;
};

export function HoursModal({
  open,
  onOpenChange,
  userId,
  month,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId: number | null;
  month: string;
}) {
  const [data, setData] = useState<HoursData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !userId) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(null);
    setError(null);
    void fetch(`/api/staff-pay/hours?user_id=${userId}&month=${month}`).then(async (res) => {
      const d = (await res.json().catch(() => null)) as (HoursData & { error?: string }) | null;
      if (!live) return;
      if (!res.ok || !d) setError(d?.error ?? "Could not load hours");
      else setData(d);
    });
    return () => {
      live = false;
    };
  }, [open, userId, month]);

  const days = data ? Object.entries(data.worked.daily) : [];
  const sessionsOn = (day: string) =>
    (data?.sessions ?? []).filter(
      (s) =>
        new Date(new Date(s.started_at).getTime() + 8 * 3600_000).toISOString().slice(0, 10) === day,
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          {data?.full_name ?? "Hours"} — {monthLabel(month)}
        </DialogTitle>
        <DialogDescription>
          Signed in and active: sign-in to sign-out, stopping at the last input when the page
          locked after 5 idle minutes.
        </DialogDescription>
        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : !data ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-sm">
              <span className="font-semibold tabular-nums">{data.worked.hours} h</span>
              <span className="text-muted-foreground"> over </span>
              <span className="font-semibold tabular-nums">{data.worked.days} days</span>
            </div>
            <div className="max-h-[50vh] overflow-y-auto rounded-md border">
              {days.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No time on the clock this month.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {days.map(([day, hours]) => (
                      <tr key={day} className="border-b last:border-0">
                        <td className="px-3 py-1.5 tabular-nums">
                          {new Date(`${day}T00:00:00Z`).toLocaleDateString("en-MY", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            timeZone: "UTC",
                          })}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-muted-foreground">
                          {sessionsOn(day)
                            .map((s) => `${formatClock(s.started_at)}–${formatClock(s.last_active_at)}`)
                            .join(", ")}
                        </td>
                        <td className="px-3 py-1.5 text-right font-medium tabular-nums">{hours} h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Footer({
  validation,
  busy,
  onCancel,
  onSave,
  label,
}: {
  validation: string | null;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{validation ?? ""}</span>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy} className="cursor-pointer">
          Cancel
        </Button>
        <Button onClick={onSave} disabled={!!validation || busy} className="cursor-pointer gap-1.5">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {label}
        </Button>
      </div>
    </div>
  );
}

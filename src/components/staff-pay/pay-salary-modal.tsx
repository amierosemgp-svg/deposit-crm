"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Banknote, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PickSelect } from "./pick-select";
import { ADJUSTMENT_LABEL, monthLabel, send, type AdjustmentKind, type StaffRow } from "./use-staff-pay";

type Preview = {
  user_id: number;
  full_name: string;
  company_entity_id: number;
  month: string;
  worked: { hours: number; days: number };
  tier: { name: string; basis: "monthly" | "hourly"; rate: number; min_hours: number; min_days: number } | null;
  base: number;
  adjustments: Array<{ adjustment_id: number; kind: AdjustmentKind; amount: number; reason: string; occurred_at: string }>;
  adjustments_total: number;
  net: number;
  carried: number;
};

/**
 * Pay one CS their month. Nothing about the amount is typed: pick the person
 * and the month, and the clock, the ladder and the pending adjustments say
 * what it is. The figure shown is the figure sent — if it moves before Pay
 * lands, the server refuses and the preview reloads.
 */
export function PaySalaryModal({
  open,
  onOpenChange,
  staff,
  month: initialMonth,
  userId: initialUser,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  staff: StaffRow[];
  month: string;
  userId: number | null;
  onDone: () => void;
}) {
  const me = useStore((s) => s.me);
  const bankAccounts = useStore((s) => s.bankAccounts);
  const entities = useStore((s) => s.entities);
  const entityName = useStore((s) => s.entityName);
  const isAdmin = me?.role === "super_admin";

  const [userId, setUserId] = useState("");
  const [month, setMonth] = useState(initialMonth);
  const [paidFrom, setPaidFrom] = useState("");
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUserId(initialUser ? String(initialUser) : "");
    setMonth(initialMonth);
    setPaidFrom("");
    setNotes("");
    setPreview(null);
    setPreviewError(null);
  }, [open, initialUser, initialMonth]);

  useEffect(() => {
    if (!open || !userId || !/^\d{4}-\d{2}$/.test(month)) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingPreview(true);
    void fetch(`/api/salaries/preview?user_id=${userId}&month=${month}`)
      .then(async (res) => {
        const d = (await res.json().catch(() => null)) as { preview?: Preview; error?: string } | null;
        if (!live) return;
        if (!res.ok || !d?.preview) {
          setPreview(null);
          setPreviewError(d?.error ?? "Could not work out the salary");
        } else {
          setPreview(d.preview);
          setPreviewError(null);
        }
      })
      .finally(() => live && setLoadingPreview(false));
    return () => {
      live = false;
    };
  }, [open, userId, month, reloadKey]);

  const staffItems = useMemo(
    () =>
      staff
        .filter((s) => s.status === "active" || String(s.user_id) === userId)
        .sort((a, b) => a.full_name.localeCompare(b.full_name))
        .map((s) => ({
          value: String(s.user_id),
          label: `${s.full_name} · ${entityName(s.company_entity_id)}${s.paid_salary_id ? " · paid" : ""}`,
        })),
    [staff, entityName, userId],
  );

  // The casino's own accounts first — that is whose bank normally pays.
  const payFromItems = useMemo(() => {
    const casino = preview?.company_entity_id;
    const accounts = bankAccounts
      .filter((a) => a.status === "active")
      .sort((a, b) => Number(b.entity_id === casino) - Number(a.entity_id === casino))
      .map((a) => ({
        value: `a:${a.account_id}`,
        label: `${a.label?.trim() || a.bank_name} · ${a.bank_name} ${a.account_number} — ${formatRM(a.current_balance)} (${entityName(a.entity_id)})`,
      }));
    const cash = isAdmin
      ? entities
          .filter((e) => e.entity_type === "leader" && e.status === "active")
          .map((e) => ({ value: `c:${e.entity_id}`, label: `Cash · ${e.name}` }))
      : [];
    return [...accounts, ...cash];
  }, [bankAccounts, entities, entityName, isAdmin, preview?.company_entity_id]);

  const validation = (() => {
    if (!userId) return "Pick a CS";
    if (!/^\d{4}-\d{2}$/.test(month)) return "Pick a month";
    if (!preview) return previewError ?? "Working it out…";
    if (preview.net > 0 && !paidFrom) return "Pick what it's paid from";
    return null;
  })();

  async function pay() {
    if (validation || busy || !preview) return;
    setBusy(true);
    const res = await send("/api/salaries", "POST", {
      user_id: Number(userId),
      month,
      paid_from_account_id: paidFrom.startsWith("a:") ? Number(paidFrom.slice(2)) : null,
      paid_from_cash_entity_id: paidFrom.startsWith("c:") ? Number(paidFrom.slice(2)) : null,
      expected_net: preview.net,
      notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      // The figure moved under us — show the new one.
      setReloadKey((k) => k + 1);
      return;
    }
    toast.success(
      `${preview.full_name}'s ${monthLabel(month)} salary paid — ${formatRM(preview.net)}` +
        (preview.carried ? `, ${formatRM(preview.carried)} carried to next month` : ""),
    );
    onDone();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle className="flex items-center gap-2">
          <Banknote className="h-4 w-4 text-muted-foreground" />
          Pay salary
        </DialogTitle>
        <DialogDescription>
          Worked out from the clock, the casino&apos;s tiers and anything pending — penalties
          included. Paying takes it out of the account you pick.
        </DialogDescription>

        <div className="space-y-4 py-1">
          <div className="grid grid-cols-[1fr_150px] gap-3">
            <div className="space-y-1.5">
              <Label>CS</Label>
              <PickSelect value={userId} onChange={setUserId} items={staffItems} placeholder="Who" />
            </div>
            <div className="space-y-1.5">
              <Label>Month</Label>
              <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </div>
          </div>

          {userId && (
            <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-sm">
              {loadingPreview && !preview ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working it out…
                </div>
              ) : previewError ? (
                <div className="text-red-600 dark:text-red-400">{previewError}</div>
              ) : preview ? (
                <div className="space-y-1.5">
                  <Line label="Worked" value={`${preview.worked.hours} h · ${preview.worked.days} days`} />
                  <Line
                    label={preview.tier ? `Tier: ${preview.tier.name}` : "Tier"}
                    value={
                      preview.tier
                        ? preview.tier.basis === "hourly"
                          ? `${formatRM(preview.tier.rate)} × ${preview.worked.hours} h = ${formatRM(preview.base)}`
                          : formatRM(preview.base)
                        : "No tier reached — RM 0.00"
                    }
                  />
                  {preview.adjustments.map((a) => (
                    <Line
                      key={a.adjustment_id}
                      label={`${ADJUSTMENT_LABEL[a.kind]} — ${a.reason}`}
                      value={`${a.amount > 0 ? "+" : "−"}${formatRM(Math.abs(a.amount))}`}
                      tone={a.amount > 0 ? "plus" : "minus"}
                    />
                  ))}
                  <div className="border-t pt-1.5">
                    <Line label="Pay" value={formatRM(preview.net)} strong />
                    {preview.carried > 0 && (
                      <Line
                        label="Carried to next salary"
                        value={`−${formatRM(preview.carried)}`}
                        tone="minus"
                      />
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {preview && preview.net > 0 && (
            <div className="space-y-1.5">
              <Label>Paid from</Label>
              <PickSelect
                value={paidFrom}
                onChange={setPaidFrom}
                items={payFromItems}
                placeholder="Bank account or leader's cash"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{validation ?? ""}</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="cursor-pointer">
              Cancel
            </Button>
            <Button onClick={pay} disabled={!!validation || busy} className="cursor-pointer gap-1.5">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Pay {preview ? formatRM(preview.net) : ""}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Line({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: "plus" | "minus";
  strong?: boolean;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", strong && "font-semibold")}>
      <span className="min-w-0 truncate text-muted-foreground" title={label}>
        {label}
      </span>
      <span
        className={cn(
          "shrink-0 tabular-nums",
          tone === "plus" && "text-emerald-700 dark:text-emerald-400",
          tone === "minus" && "text-red-600 dark:text-red-400",
        )}
      >
        {value}
      </span>
    </div>
  );
}

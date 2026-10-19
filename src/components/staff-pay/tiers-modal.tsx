"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Layers, Loader2, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStore } from "@/lib/store";
import { PickSelect } from "./pick-select";
import { send, type SalaryTier, type StaffRow, type TierRate } from "./use-staff-pay";

type Draft = {
  tier_id: number | null;
  name: string;
  min_hours: string;
  min_days: string;
  basis: "monthly" | "hourly";
  default_amount: string;
};

const toDraft = (t: SalaryTier): Draft => ({
  tier_id: t.tier_id,
  name: t.name,
  min_hours: String(t.min_hours),
  min_days: String(t.min_days),
  basis: t.basis,
  default_amount: String(t.default_amount),
});

const blank = (): Draft => ({
  tier_id: null,
  name: "",
  min_hours: "",
  min_days: "",
  basis: "monthly",
  default_amount: "",
});

/**
 * A casino's salary ladder, and what each rung pays each CS.
 *
 * The rungs are shared: hours and days to reach one, and what it pays by
 * default. Each CS can then be paid differently on the same rung — the grid
 * below. Nobody edits their own row.
 */
export function TiersModal({
  open,
  onOpenChange,
  tiers,
  rates,
  staff,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tiers: SalaryTier[];
  rates: TierRate[];
  staff: StaffRow[];
  onDone: () => void;
}) {
  const me = useStore((s) => s.me);
  const entities = useStore((s) => s.entities);
  const companyInScope = useStore((s) => s.companyInScope);
  const isViewer = me?.role === "viewer";

  const casinos = useMemo(
    () =>
      entities
        .filter((e) => e.entity_type === "company" && e.status === "active" && companyInScope(e.entity_id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [entities, companyInScope],
  );
  const [casinoId, setCasinoId] = useState("");
  useEffect(() => {
    if (!open) return;
    // Start on whichever casino has a CS — the first one worth setting up.
    const withStaff = casinos.find((c) => staff.some((s) => s.company_entity_id === c.entity_id));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCasinoId((prev) => prev || String(withStaff?.entity_id ?? casinos[0]?.entity_id ?? ""));
  }, [open, casinos, staff]);

  const ladder = useMemo(
    () => tiers.filter((t) => t.company_entity_id === Number(casinoId) && t.status === "active"),
    [tiers, casinoId],
  );
  const [drafts, setDrafts] = useState<Draft[]>([]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrafts(ladder.map(toDraft));
  }, [ladder]);

  const [busy, setBusy] = useState<string | null>(null);

  const patch = (i: number, p: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...p } : d)));

  async function saveTier(i: number) {
    const d = drafts[i];
    const body = {
      name: d.name.trim(),
      min_hours: Number(d.min_hours) || 0,
      min_days: Math.trunc(Number(d.min_days) || 0),
      basis: d.basis,
      default_amount: Number(d.default_amount) || 0,
    };
    if (!body.name) return void toast.error("Give the tier a name");
    setBusy(`tier:${i}`);
    const res = d.tier_id
      ? await send(`/api/salary-tiers/${d.tier_id}`, "PATCH", body)
      : await send("/api/salary-tiers", "POST", { ...body, company_entity_id: Number(casinoId) });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    toast.success(`Tier "${body.name}" saved`);
    onDone();
  }

  async function removeTier(i: number) {
    const d = drafts[i];
    if (!d.tier_id) return void setDrafts((ds) => ds.filter((_, j) => j !== i));
    setBusy(`tier:${i}`);
    const res = await send(`/api/salary-tiers/${d.tier_id}`, "DELETE");
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    toast.success(`Tier "${d.name}" removed`);
    onDone();
  }

  const casinoStaff = useMemo(
    () =>
      staff
        .filter((s) => s.company_entity_id === Number(casinoId) && s.status === "active")
        .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [staff, casinoId],
  );
  const rateOf = useMemo(() => new Map(rates.map((r) => [`${r.user_id}:${r.tier_id}`, r.amount])), [rates]);

  async function saveRate(userId: number, tier: SalaryTier, raw: string) {
    const current = rateOf.get(`${userId}:${tier.tier_id}`);
    const next = raw.trim() === "" ? null : Number(raw);
    if (next !== null && (!Number.isFinite(next) || next < 0)) return void toast.error("Enter an amount, or leave blank for the default");
    if ((current ?? null) === next) return;
    setBusy(`rate:${userId}:${tier.tier_id}`);
    const res = await send("/api/salary-tiers/rates", "PUT", { user_id: userId, tier_id: tier.tier_id, amount: next });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    onDone();
  }

  const dirty = (i: number) => {
    const d = drafts[i];
    const t = ladder.find((x) => x.tier_id === d.tier_id);
    return !t || JSON.stringify(toDraft(t)) !== JSON.stringify(d);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          Salary tiers
        </DialogTitle>
        <DialogDescription>
          A CS gets the highest tier whose hours <em>and</em> days they reached that month. Monthly
          pays the amount; hourly pays it per hour worked. Below the lowest tier pays nothing — add a
          0-hour tier for a base.
        </DialogDescription>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto py-1 pr-1">
          <div className="max-w-xs space-y-1.5">
            <Label>Casino</Label>
            <PickSelect
              value={casinoId}
              onChange={setCasinoId}
              items={casinos.map((c) => ({ value: String(c.entity_id), label: c.name }))}
            />
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_90px_80px_110px_110px_72px] gap-2 text-xs font-medium text-muted-foreground">
              <span>Tier</span>
              <span>Min hours</span>
              <span>Min days</span>
              <span>Pays</span>
              <span>Default (RM)</span>
              <span />
            </div>
            {drafts.map((d, i) => (
              <div key={d.tier_id ?? `new-${i}`} className="grid grid-cols-[1fr_90px_80px_110px_110px_72px] items-center gap-2">
                <Input value={d.name} onChange={(e) => patch(i, { name: e.target.value })} placeholder="e.g. Full-time" disabled={isViewer} />
                <Input type="number" min={0} value={d.min_hours} onChange={(e) => patch(i, { min_hours: e.target.value })} placeholder="0" disabled={isViewer} />
                <Input type="number" min={0} max={31} value={d.min_days} onChange={(e) => patch(i, { min_days: e.target.value })} placeholder="0" disabled={isViewer} />
                <PickSelect
                  value={d.basis}
                  onChange={(v) => patch(i, { basis: v as Draft["basis"] })}
                  items={[
                    { value: "monthly", label: "Per month" },
                    { value: "hourly", label: "Per hour" },
                  ]}
                  disabled={isViewer}
                />
                <Input type="number" min={0} step="0.01" value={d.default_amount} onChange={(e) => patch(i, { default_amount: e.target.value })} placeholder="0.00" disabled={isViewer} />
                {!isViewer && (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant={dirty(i) ? "default" : "outline"}
                      className="h-8 cursor-pointer px-2"
                      disabled={!dirty(i) || busy === `tier:${i}`}
                      onClick={() => void saveTier(i)}
                    >
                      {busy === `tier:${i}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 cursor-pointer px-2 text-muted-foreground hover:text-red-600"
                      title="Remove tier"
                      onClick={() => void removeTier(i)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {!isViewer && casinoId && (
              <Button
                size="sm"
                variant="outline"
                className="cursor-pointer gap-1.5"
                onClick={() => setDrafts((ds) => [...ds, blank()])}
              >
                <Plus className="h-3.5 w-3.5" /> Add tier
              </Button>
            )}
          </div>

          {ladder.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium">Pay per CS</div>
              <p className="text-xs text-muted-foreground">
                Blank uses the tier&apos;s default. Saved when you leave the cell.
              </p>
              {casinoStaff.length === 0 ? (
                <p className="text-sm text-muted-foreground">No CS at this casino.</p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                        <th className="px-3 py-1.5 text-left font-medium">CS</th>
                        {ladder.map((t) => (
                          <th key={t.tier_id} className="px-2 py-1.5 text-right font-medium">
                            {t.name}
                            {t.basis === "hourly" ? " /h" : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {casinoStaff.map((s) => {
                        const self = s.user_id === me?.user_id;
                        return (
                          <tr key={s.user_id} className="border-b last:border-0">
                            <td className="px-3 py-1.5">
                              {s.full_name}
                              {self && <span className="ml-1 text-xs text-muted-foreground">(you — set by someone else)</span>}
                            </td>
                            {ladder.map((t) => {
                              const own = rateOf.get(`${s.user_id}:${t.tier_id}`);
                              return (
                                <td key={t.tier_id} className="px-2 py-1">
                                  <Input
                                    key={`${s.user_id}:${t.tier_id}:${own ?? ""}`}
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    defaultValue={own ?? ""}
                                    placeholder={String(t.default_amount)}
                                    disabled={isViewer || self || busy === `rate:${s.user_id}:${t.tier_id}`}
                                    onBlur={(e) => void saveRate(s.user_id, t, e.target.value)}
                                    className="h-8 text-right"
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

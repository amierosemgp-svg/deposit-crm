"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Gift, Loader2, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { ListLoading } from "@/components/list-loading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/status-badge";
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
import {
  BONUS_PERIOD_LABELS,
  type BonusPeriod,
  type BonusPlan,
  type BonusPlanType,
} from "@/lib/types";

const TYPE_OPTIONS: { value: BonusPlanType; label: string; blurb: string }[] = [
  {
    value: "welcome",
    label: "Welcome",
    blurb: "The player's first deposit, once ever.",
  },
  {
    value: "recurring",
    label: "Daily / weekly / monthly",
    blurb: "Claimable once per period, on any deposit that clears the minimum.",
  },
  {
    value: "rebate",
    label: "Rebate",
    blurb:
      "A share of what the player lost over the period — deposits minus withdrawals — claimable once per period.",
  },
];

/** The rule, as a sentence, so nobody has to read the columns to know what it does. */
function describePlan(plan: BonusPlan): string {
  const bits: string[] = [];
  if (plan.type === "welcome") {
    bits.push(`${plan.percentage}% of the first deposit, once ever`);
  } else if (plan.type === "recurring") {
    bits.push(
      `${plan.percentage}% of the deposit, once ${periodPhrase(plan.period)}`,
    );
  } else {
    bits.push(
      `${plan.percentage}% of the loss, once ${periodPhrase(plan.period)}`,
    );
  }
  if (plan.min_deposit > 0) bits.push(`deposit ≥ ${formatRM(plan.min_deposit)}`);
  if (plan.type === "rebate" && plan.min_loss > 0) {
    bits.push(`loss ≥ ${formatRM(plan.min_loss)}`);
  }
  return bits.join(" · ");
}

function periodPhrase(period: BonusPeriod | null): string {
  return period === "weekly"
    ? "a week"
    : period === "monthly"
      ? "a month"
      : "a day";
}

/**
 * The bonus catalogue CS picks from on the deposits screen.
 *
 * A bonus is a rule, not a number — who may have it and how often — so this is
 * where the rule is written once instead of being re-decided per deposit.
 */
export default function BonusesPage() {
  const me = useStore((s) => s.me);
  const plans = useStore((s) => s.bonusPlans);
  const hydrated = useStore((s) => s.hydrated);
  const entityName = useStore((s) => s.entityName);
  const updateBonusPlan = useStore((s) => s.updateBonusPlan);
  const deleteBonusPlan = useStore((s) => s.deleteBonusPlan);

  const [editing, setEditing] = useState<BonusPlan | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const canWrite = me?.role === "super_admin" || me?.role === "company_leader";

  async function toggleStatus(plan: BonusPlan) {
    setBusyId(plan.plan_id);
    const next = plan.status === "active" ? "inactive" : "active";
    const r = await updateBonusPlan(plan.plan_id, { status: next });
    setBusyId(null);
    if (!r.ok) toast.error(r.error ?? "Failed to update bonus");
    else toast.success(`${plan.name} switched ${next === "active" ? "on" : "off"}`);
  }

  async function remove(plan: BonusPlan) {
    setBusyId(plan.plan_id);
    const r = await deleteBonusPlan(plan.plan_id);
    setBusyId(null);
    if (!r.ok) toast.error(r.error ?? "Failed to delete bonus");
    else toast.success(`${plan.name} deleted`);
  }

  if (me && !canWrite) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Bonuses</h1>
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Only leaders and admins manage bonuses.
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bonuses</h1>
          <p className="text-sm text-muted-foreground mt-1">
            What CS can hand out on a deposit, and who qualifies — the deposits
            screen checks each of these against the player before it lets one
            through
          </p>
        </div>
        <Button onClick={() => setCreating(true)} className="shrink-0 cursor-pointer">
          <Plus className="h-3.5 w-3.5" />
          Add bonus
        </Button>
      </div>

      <Card className="p-5">
        {!hydrated ? (
          <ListLoading label="Loading bonuses…" />
        ) : plans.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Gift className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">No bonuses yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Until one exists, deposits can only carry an ad-hoc percentage
              with no rule behind it.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Bonus</th>
                  <th className="px-2 py-2 font-medium">Rule</th>
                  <th className="px-2 py-2 font-medium">Applies to</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.plan_id} className="border-b last:border-b-0">
                    <td className="px-2 py-2.5">
                      <div className="font-medium">{plan.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className="rounded-full border px-1.5 py-px text-[10px] text-muted-foreground">
                          {plan.type === "welcome"
                            ? "Welcome"
                            : plan.type === "rebate"
                              ? "Rebate"
                              : "Recurring"}
                        </span>
                        {plan.period && (
                          <span className="text-[10px] text-muted-foreground">
                            {BONUS_PERIOD_LABELS[plan.period]}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 text-[12px] text-muted-foreground">
                      {describePlan(plan)}
                      {plan.notes && (
                        <div className="mt-0.5 text-[11px] italic">{plan.notes}</div>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-[12px]">
                      {plan.company_entity_id === null ? (
                        <span className="text-muted-foreground">All companies</span>
                      ) : (
                        entityName(plan.company_entity_id)
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusBadge status={plan.status} />
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {busyId === plan.plan_id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => setEditing(plan)}
                              title="Edit"
                              className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void toggleStatus(plan)}
                              title={
                                plan.status === "active"
                                  ? "Switch off — takes it out of the dropdown"
                                  : "Switch on"
                              }
                              className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              <Power className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void remove(plan)}
                              title="Delete — only possible while no deposit has used it"
                              className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-red-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <BonusPlanDialog
        open={creating || editing !== null}
        plan={editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      />
    </div>
  );
}

/** Add or edit one bonus. The same form both ways — an edit just starts filled in. */
function BonusPlanDialog({
  open,
  plan,
  onOpenChange,
}: {
  open: boolean;
  plan: BonusPlan | null;
  onOpenChange: (open: boolean) => void;
}) {
  const me = useStore((s) => s.me);
  const companiesFn = useStore((s) => s.companies);
  const createBonusPlan = useStore((s) => s.createBonusPlan);
  const updateBonusPlan = useStore((s) => s.updateBonusPlan);

  const companies = companiesFn();
  const isAdmin = me?.role === "super_admin";

  const [name, setName] = useState("");
  const [type, setType] = useState<BonusPlanType>("recurring");
  const [period, setPeriod] = useState<BonusPeriod>("daily");
  const [percentage, setPercentage] = useState("10");
  const [minDeposit, setMinDeposit] = useState("0");
  const [minLoss, setMinLoss] = useState("0");
  const [scope, setScope] = useState<string>(isAdmin ? "all" : "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  // Refill from the plan being edited whenever the dialog is (re)opened on a
  // different row — state-during-render, the pattern the rest of the CRM uses.
  const key = `${open}:${plan?.plan_id ?? "new"}`;
  const [syncedKey, setSyncedKey] = useState(key);
  if (key !== syncedKey) {
    setSyncedKey(key);
    if (open) {
      setName(plan?.name ?? "");
      setType(plan?.type ?? "recurring");
      setPeriod(plan?.period ?? "daily");
      setPercentage(String(plan?.percentage ?? 10));
      setMinDeposit(String(plan?.min_deposit ?? 0));
      setMinLoss(String(plan?.min_loss ?? 0));
      setScope(
        plan
          ? plan.company_entity_id === null
            ? "all"
            : String(plan.company_entity_id)
          : isAdmin
            ? "all"
            : String(companies[0]?.company_id ?? ""),
      );
      setNotes(plan?.notes ?? "");
    }
  }

  const pct = Number(percentage);
  const isValid =
    name.trim().length > 0 &&
    Number.isFinite(pct) &&
    pct > 0 &&
    pct <= 500 &&
    (isAdmin || scope !== "all") &&
    scope !== "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || busy) return;
    setBusy(true);
    const payload = {
      name: name.trim(),
      type,
      period: type === "welcome" ? null : period,
      percentage: pct,
      min_deposit: Number(minDeposit) || 0,
      min_loss: type === "rebate" ? Number(minLoss) || 0 : 0,
      company_entity_id: scope === "all" ? null : Number(scope),
      notes: notes.trim() || null,
    };
    const r = plan
      ? await updateBonusPlan(plan.plan_id, payload)
      : await createBonusPlan(payload);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Failed to save bonus");
      return;
    }
    toast.success(plan ? `${payload.name} updated` : `${payload.name} added`);
    onOpenChange(false);
  }

  const typeBlurb = TYPE_OPTIONS.find((t) => t.value === type)?.blurb;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>{plan ? "Edit bonus" : "Add bonus"}</DialogTitle>
        <DialogDescription>
          {plan
            ? "Changes apply to future deposits — what has already been paid out keeps the rate it was given."
            : "Set the rule once; the deposits screen enforces it per player."}
        </DialogDescription>

        <form onSubmit={submit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="bp-name">
              Name <span className="text-rose-600 dark:text-rose-400">*</span>
            </Label>
            <Input
              id="bp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Welcome 100%"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType((v as BonusPlanType) ?? "recurring")}
              items={TYPE_OPTIONS.map((t) => ({ value: t.value, label: t.label }))}
            >
              <SelectTrigger className="w-full cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {typeBlurb && (
              <p className="text-[11px] leading-snug text-muted-foreground">
                {typeBlurb}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {type !== "welcome" && (
              <div className="space-y-1.5">
                <Label>Resets</Label>
                <Select
                  value={period}
                  onValueChange={(v) => setPeriod((v as BonusPeriod) ?? "daily")}
                  items={Object.entries(BONUS_PERIOD_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                >
                  <SelectTrigger className="w-full cursor-pointer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(BONUS_PERIOD_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="bp-pct">
                Percentage <span className="text-rose-600 dark:text-rose-400">*</span>
              </Label>
              <Input
                id="bp-pct"
                type="number"
                min="0.01"
                max="500"
                step="0.01"
                inputMode="decimal"
                value={percentage}
                onChange={(e) => setPercentage(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bp-min">Minimum deposit (RM)</Label>
              <Input
                id="bp-min"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={minDeposit}
                onChange={(e) => setMinDeposit(e.target.value)}
                placeholder="0"
              />
            </div>
            {type === "rebate" && (
              <div className="space-y-1.5">
                <Label htmlFor="bp-loss">Minimum loss (RM)</Label>
                <Input
                  id="bp-loss"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={minLoss}
                  onChange={(e) => setMinLoss(e.target.value)}
                  placeholder="0"
                />
              </div>
            )}
          </div>

          {type === "rebate" && (
            <p className="rounded-md border bg-muted/30 p-2.5 text-[11px] leading-snug text-muted-foreground">
              The rebate pays {Number.isFinite(pct) ? pct : 0}% of what the player is
              down over the period — completed deposits minus paid withdrawals —
              not a share of the deposit in front of CS.
            </p>
          )}

          <div className="space-y-1.5">
            <Label>Applies to</Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v ?? "")}
              items={[
                ...(isAdmin ? [{ value: "all", label: "All companies" }] : []),
                ...companies.map((c) => ({
                  value: String(c.company_id),
                  label: c.company_name,
                })),
              ]}
            >
              <SelectTrigger className="w-full cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {isAdmin && <SelectItem value="all">All companies</SelectItem>}
                {companies.map((c) => (
                  <SelectItem key={c.company_id} value={String(c.company_id)}>
                    {c.company_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!isAdmin && (
              <p className="text-[11px] text-muted-foreground">
                Only the super admin creates bonuses that apply to every company.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bp-notes">Notes</Label>
            <Input
              id="bp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional — what this is for"
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid || busy} className="cursor-pointer">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {plan ? "Save changes" : "Add bonus"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

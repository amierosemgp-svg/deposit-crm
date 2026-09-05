"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Banknote, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";
import type { BankAccount } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account the cash came out of. */
  account: BankAccount | null;
  /** Fired after a successful record, so the page can refetch its list. */
  onRecorded?: () => void;
};

const OTHER = "__other__";

/** "YYYY-MM-DDTHH:MM" in local time, for a datetime-local input. */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/**
 * Record cash a leader took out of a company bank account by hand — the one
 * way money leaves an account that no other screen captures. Debits the
 * account when saved, so the balance here matches the bank's.
 */
export function BankCashOutModal({ open, onOpenChange, account, onRecorded }: Props) {
  const entities = useStore((s) => s.entities);
  const entityName = useStore((s) => s.entityName);
  const record = useStore((s) => s.recordBankCashOut);

  // Leaders to pick from; the account's own company's leader comes first.
  const leaders = useMemo(() => {
    const company = account ? entities.find((e) => e.entity_id === account.entity_id) : undefined;
    const own = company?.parent_entity_id ?? null;
    return entities
      .filter((e) => e.entity_type === "leader" && e.status === "active")
      .sort((a, b) =>
        a.entity_id === own ? -1 : b.entity_id === own ? 1 : a.name.localeCompare(b.name),
      );
  }, [entities, account]);
  const ownLeaderId = useMemo(() => {
    const company = account ? entities.find((e) => e.entity_id === account.entity_id) : undefined;
    return company?.parent_entity_id ?? null;
  }, [entities, account]);

  // Base UI's Select renders the raw value in the trigger unless it's told
  // what each value is called — hence the items map.
  const takenByItems = useMemo(
    () => [
      ...leaders.map((l) => ({
        value: String(l.entity_id),
        label: l.entity_id === ownLeaderId ? `${l.name} · this company's leader` : l.name,
      })),
      { value: OTHER, label: "Someone else…" },
    ],
    [leaders, ownLeaderId],
  );

  const [amount, setAmount] = useState("");
  const [takenBy, setTakenBy] = useState<string>("");
  const [otherName, setOtherName] = useState("");
  const [when, setWhen] = useState(() => localInputValue(new Date()));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Reset the form each time the dialog opens — same pattern as the
    // transfer modal; the dialog is the external system being synced to.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAmount("");
    setTakenBy(ownLeaderId ? String(ownLeaderId) : leaders[0] ? String(leaders[0].entity_id) : OTHER);
    setOtherName("");
    setWhen(localInputValue(new Date()));
    setNotes("");
    setBusy(false);
  }, [open, ownLeaderId, leaders]);

  const amt = Number(amount) || 0;
  const validation = (() => {
    if (!account) return "No account";
    if (amt <= 0) return "Enter an amount greater than 0";
    if (amt > account.current_balance) return "Exceeds the account balance";
    if (takenBy === OTHER && !otherName.trim()) return "Say who took the cash";
    if (!when || Number.isNaN(new Date(when).getTime())) return "Enter when it was withdrawn";
    return null;
  })();

  async function submit() {
    if (!account || validation || busy) return;
    setBusy(true);
    const res = await record({
      accountId: account.account_id,
      amount: amt,
      takenByEntityId: takenBy === OTHER ? null : Number(takenBy),
      takenBy: takenBy === OTHER ? otherName.trim() : undefined,
      occurredAt: new Date(when).toISOString(),
      notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error ?? "Could not record the cash-out");
      return;
    }
    toast.success(`${formatRM(amt)} cash-out recorded — balance updated`);
    onRecorded?.();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="flex items-center gap-2">
          <Banknote className="h-4 w-4 text-muted-foreground" />
          Record cash withdrawal
        </DialogTitle>
        <DialogDescription>
          Cash a leader took out of this account at the bank. Saving it takes the amount
          off the account&apos;s balance here.
        </DialogDescription>

        {account && (
          <div className="space-y-4 py-2">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="font-medium">
                {account.bank_name} · {account.account_number}
              </div>
              <div className="text-xs text-muted-foreground">
                {entityName(account.entity_id)} · balance{" "}
                <span className="font-medium text-foreground">{formatRM(account.current_balance)}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Amount (RM)</Label>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label>Taken by</Label>
              <Select value={takenBy} onValueChange={(v) => setTakenBy(v ?? "")} items={takenByItems}>
                <SelectTrigger className="w-full cursor-pointer">
                  <SelectValue placeholder="Who took the cash" />
                </SelectTrigger>
                <SelectContent>
                  {takenByItems.map((it) => (
                    <SelectItem key={it.value} value={it.value} className="cursor-pointer">
                      {it.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {takenBy === OTHER && (
                <Input
                  value={otherName}
                  onChange={(e) => setOtherName(e.target.value)}
                  placeholder="Name"
                  maxLength={120}
                />
              )}
            </div>

            <div className="space-y-1.5">
              <Label>When</Label>
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label>Notes (optional)</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. petty cash, receipt no."
                maxLength={500}
              />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{validation ?? ""}</span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button onClick={submit} disabled={!!validation || busy} className="cursor-pointer">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Record {amt > 0 ? formatRM(amt) : "cash-out"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

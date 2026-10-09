"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";
import type { BankAccount, BankTransfer } from "@/lib/types";

type Props = {
  transfer: BankTransfer | null;
  onOpenChange: (open: boolean) => void;
};

/**
 * Correct a settled bank transfer: either account, the amount, the notes.
 *
 * The common fix is the To account — two companies each have an "MBB 2-ENT",
 * so every account here carries its company's name. Saving re-books both
 * banks on the server (PATCH /api/transfers/:id) and puts the change on the
 * System Log.
 */
export function BankTransferEditModal({ transfer, onOpenChange }: Props) {
  const accounts = useStore((s) => s.transferAccounts);
  const storeEntityName = useStore((s) => s.entityName);
  const updateTransfer = useStore((s) => s.updateBankTransfer);
  const entityName = useCallback(
    (id: number) => accounts.find((a) => a.entity_id === id)?.entity_name ?? storeEntityName(id),
    [accounts, storeEntityName],
  );

  // Seeded from the transfer once: the page keys this modal by transfer id, so
  // opening another row mounts a fresh one.
  const [fromId, setFromId] = useState(transfer ? String(transfer.from_account_id) : "");
  const [toId, setToId] = useState(transfer ? String(transfer.to_account_id) : "");
  const [amount, setAmount] = useState(transfer ? String(transfer.amount) : "");
  const [notes, setNotes] = useState(transfer?.notes ?? "");
  const [saving, setSaving] = useState(false);

  // Active accounts, plus the two the transfer already names even if one has
  // since been closed — the server allows keeping them.
  const choices = useMemo(
    () =>
      accounts.filter(
        (a) =>
          a.status === "active" ||
          a.account_id === transfer?.from_account_id ||
          a.account_id === transfer?.to_account_id,
      ),
    [accounts, transfer],
  );
  const groups = useMemo(() => {
    const map = new Map<number, BankAccount[]>();
    for (const a of choices) map.set(a.entity_id, [...(map.get(a.entity_id) ?? []), a]);
    return [...map.entries()].map(([entityId, accts]) => ({ entityId, accounts: accts }));
  }, [choices]);

  const label = (a: BankAccount) =>
    `${a.bank_name} · ${a.account_number}${a.label ? ` · ${a.label}` : ""}`;
  const items = choices.map((a) => ({
    value: String(a.account_id),
    label: `${label(a)} · ${entityName(a.entity_id)}`,
  }));

  if (!transfer) return null;
  const amt = Number(amount) || 0;
  const patch: Record<string, unknown> = {};
  if (Number(fromId) !== transfer.from_account_id) patch.from_account_id = Number(fromId);
  if (Number(toId) !== transfer.to_account_id) patch.to_account_id = Number(toId);
  if (amt !== transfer.amount) patch.amount = amt;
  if (notes.trim() !== (transfer.notes ?? "")) patch.notes = notes.trim() || null;
  const validation =
    !fromId || !toId
      ? "Pick both accounts"
      : fromId === toId
        ? "From and To must differ"
        : amt <= 0
          ? "Enter an amount greater than 0"
          : null;
  const canSave = !validation && !saving && Object.keys(patch).length > 0;

  async function save() {
    if (!canSave || !transfer) return;
    setSaving(true);
    const res = await updateTransfer(transfer.transfer_id, patch);
    setSaving(false);
    if (!res.ok) return void toast.error(res.error ?? "Could not save the correction");
    toast.success("Transfer corrected — both accounts re-booked");
    onOpenChange(false);
  }

  const picker = (value: string, onChange: (v: string) => void, placeholder: string) => (
    <Select value={value} onValueChange={(v) => onChange(v ?? "")} items={items}>
      <SelectTrigger className="h-9 w-full cursor-pointer">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {groups.map((g) => (
          <SelectGroup key={g.entityId}>
            <SelectLabel>{entityName(g.entityId)}</SelectLabel>
            {g.accounts.map((a) => (
              <SelectItem key={a.account_id} value={String(a.account_id)} className="cursor-pointer">
                {label(a)} · {entityName(a.entity_id)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Dialog open={transfer !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">Edit bank transfer</DialogTitle>
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Pencil className="h-4 w-4" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold leading-tight">Edit transfer</h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              Both banks are re-booked on save, and the change goes on the System Log
            </p>
          </div>
        </div>

        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <Label>From</Label>
            {picker(fromId, setFromId, "Source account")}
          </div>
          <div className="space-y-1.5">
            <Label>To</Label>
            {picker(toId, setToId, "Destination account")}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bte-amount">Amount (RM)</Label>
            <Input
              id="bte-amount"
              type="number"
              step="0.01"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bte-notes">Notes</Label>
            <textarea
              id="bte-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 resize-none"
            />
          </div>
          {validation && <p className="text-[11px] text-rose-600 dark:text-rose-400">{validation}</p>}

          <div className="flex items-center justify-end gap-2 border-t bg-muted/30 -mx-5 -mb-5 px-5 py-3 mt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={!canSave} className="cursor-pointer">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save {amt > 0 ? formatRM(amt) : ""}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

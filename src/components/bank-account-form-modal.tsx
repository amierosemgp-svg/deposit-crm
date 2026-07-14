"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Landmark, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
import type { BankAccount } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: BankAccount | null;
};

const OTHER_BANK = "__other__";

type FormState = {
  entity_id: string;
  role: "deposit" | "withdrawal";
  bank_select: string; // a bank name from settings, or OTHER_BANK
  bank_custom: string; // free text when OTHER_BANK
  account_number: string;
  account_holder: string;
  label: string;
  current_balance: string;
  status: "active" | "inactive";
};

const EMPTY: FormState = {
  entity_id: "",
  role: "deposit",
  bank_select: "",
  bank_custom: "",
  account_number: "",
  account_holder: "",
  label: "",
  current_balance: "0",
  status: "active",
};

const ROLE_HINTS: Record<FormState["role"], string> = {
  deposit:
    "Collection account — receives player deposits and is watched by the bank bot.",
  withdrawal: "Payout account — used to pay player withdrawals.",
};

export function BankAccountFormModal({ open, onOpenChange, account }: Props) {
  const addAccount = useStore((s) => s.addBankAccount);
  const updateAccount = useStore((s) => s.updateBankAccount);
  const entities = useStore((s) => s.entities);
  const me = useStore((s) => s.me);
  const banks = useStore((s) => s.banks)();
  const isEdit = !!account;

  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);

  // Entities that can own bank accounts: leaders & companies the user manages
  const eligibleEntities = useMemo(
    () =>
      entities.filter(
        (e) =>
          (e.entity_type === "leader" || e.entity_type === "company") &&
          e.status === "active" &&
          (!me || me.ownedEntityIds === null || me.ownedEntityIds.includes(e.entity_id)),
      ),
    [entities, me],
  );

  useEffect(() => {
    if (open) {
      if (account) {
        const known = banks.includes(account.bank_name);
        setForm({
          entity_id: String(account.entity_id),
          role: account.role,
          bank_select: known ? account.bank_name : OTHER_BANK,
          bank_custom: known ? "" : account.bank_name,
          account_number: account.account_number,
          account_holder: account.account_holder,
          label: account.label ?? "",
          current_balance: String(account.current_balance),
          status: account.status,
        });
      } else {
        setForm(EMPTY);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account]);

  const bankName =
    form.bank_select === OTHER_BANK ? form.bank_custom.trim() : form.bank_select;

  const errors = {
    entity_id: !form.entity_id ? "Required" : null,
    bank_name: !bankName ? "Required" : null,
    account_number: !form.account_number.trim() ? "Required" : null,
    account_holder: !form.account_holder.trim() ? "Required" : null,
    current_balance:
      !isEdit &&
      (form.current_balance === "" || isNaN(Number(form.current_balance)))
        ? "Enter a valid amount"
        : null,
  };
  const isValid = Object.values(errors).every((e) => e === null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);

    let result;
    if (isEdit && account) {
      result = await updateAccount(account.account_id, {
        entity_id: Number(form.entity_id),
        role: form.role,
        bank_name: bankName,
        account_number: form.account_number.trim(),
        account_holder: form.account_holder.trim(),
        label: form.label.trim() || undefined,
        status: form.status,
      });
    } else {
      result = await addAccount({
        entity_id: Number(form.entity_id),
        role: form.role,
        bank_name: bankName,
        account_number: form.account_number.trim(),
        account_holder: form.account_holder.trim(),
        label: form.label.trim() || undefined,
        current_balance: Number(form.current_balance),
        status: form.status,
      });
    }
    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.error ?? "Could not save bank account");
      return;
    }
    toast.success(isEdit ? "Bank account updated" : "Bank account added");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">
          {isEdit ? "Edit bank account" : "Add bank account"}
        </DialogTitle>

        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Landmark className="h-4.5 w-4.5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold leading-tight">
              {isEdit ? "Edit bank account" : "Add bank account"}
            </h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              Entity-owned account for collections or payouts
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 p-5">
          <div className="space-y-1.5">
            <Label>
              Entity <span className="text-rose-600">*</span>
            </Label>
            <Select
              value={form.entity_id}
              onValueChange={(v) => update("entity_id", v ?? "")}
            >
              <SelectTrigger
                className="h-8 w-full cursor-pointer"
                aria-invalid={!!errors.entity_id}
              >
                <SelectValue placeholder="Select leader or company" />
              </SelectTrigger>
              <SelectContent>
                {eligibleEntities.length === 0 && (
                  <div className="px-3 py-2 text-[12px] text-muted-foreground">
                    No eligible entities
                  </div>
                )}
                {eligibleEntities.map((e) => (
                  <SelectItem
                    key={e.entity_id}
                    value={String(e.entity_id)}
                    className="cursor-pointer"
                  >
                    {e.name} ({e.entity_type === "leader" ? "Leader" : "Company"})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              Role <span className="text-rose-600">*</span>
            </Label>
            <Select
              value={form.role}
              onValueChange={(v) =>
                update("role", (v as "deposit" | "withdrawal") ?? "deposit")
              }
            >
              <SelectTrigger className="h-8 w-full cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deposit" className="cursor-pointer">
                  Deposit · Collection
                </SelectItem>
                <SelectItem value="withdrawal" className="cursor-pointer">
                  Withdrawal · Payout
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{ROLE_HINTS[form.role]}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>
                Bank <span className="text-rose-600">*</span>
              </Label>
              <Select
                value={form.bank_select}
                onValueChange={(v) => update("bank_select", v ?? "")}
              >
                <SelectTrigger
                  className="h-8 w-full cursor-pointer"
                  aria-invalid={!!errors.bank_name}
                >
                  <SelectValue placeholder="Select bank" />
                </SelectTrigger>
                <SelectContent>
                  {banks.map((b) => (
                    <SelectItem key={b} value={b} className="cursor-pointer">
                      {b}
                    </SelectItem>
                  ))}
                  <SelectItem value={OTHER_BANK} className="cursor-pointer">
                    Other…
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ba-label">Label</Label>
              <Input
                id="ba-label"
                value={form.label}
                onChange={(e) => update("label", e.target.value)}
                placeholder="Main, Backup, Payouts…"
              />
            </div>
          </div>

          {form.bank_select === OTHER_BANK && (
            <div className="space-y-1.5">
              <Label htmlFor="ba-bank-custom">
                Bank name <span className="text-rose-600">*</span>
              </Label>
              <Input
                id="ba-bank-custom"
                value={form.bank_custom}
                onChange={(e) => update("bank_custom", e.target.value)}
                placeholder="Type the bank name"
                aria-invalid={!!errors.bank_name}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ba-num">
              Account number <span className="text-rose-600">*</span>
            </Label>
            <Input
              id="ba-num"
              value={form.account_number}
              onChange={(e) => update("account_number", e.target.value)}
              placeholder="5145 8800 1122"
              inputMode="numeric"
              aria-invalid={!!errors.account_number}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ba-holder">
              Account holder <span className="text-rose-600">*</span>
            </Label>
            <Input
              id="ba-holder"
              value={form.account_holder}
              onChange={(e) => update("account_holder", e.target.value)}
              placeholder="Leader Alpha Sdn Bhd"
              aria-invalid={!!errors.account_holder}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {!isEdit && (
              <div className="space-y-1.5">
                <Label htmlFor="ba-bal">Opening balance (RM)</Label>
                <Input
                  id="ba-bal"
                  type="number"
                  step="0.01"
                  value={form.current_balance}
                  onChange={(e) => update("current_balance", e.target.value)}
                  aria-invalid={!!errors.current_balance}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) =>
                  update("status", (v as "active" | "inactive") ?? "active")
                }
              >
                <SelectTrigger className="h-8 w-full cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active" className="cursor-pointer">
                    Active
                  </SelectItem>
                  <SelectItem value="inactive" className="cursor-pointer">
                    Inactive
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t bg-muted/30 -mx-5 -mb-5 px-5 py-3 mt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isValid || submitting}
              className="cursor-pointer"
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isEdit ? "Save changes" : "Add bank account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

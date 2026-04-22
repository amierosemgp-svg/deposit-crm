"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Landmark } from "lucide-react";
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
import { COMPANIES } from "@/lib/mock-data";
import { useStore } from "@/lib/store";
import { BANKS, type BankName, type CompanyBankAccount } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: CompanyBankAccount | null;
};

type FormState = {
  company_id: string;
  bank_name: string;
  account_number: string;
  account_holder: string;
  label: string;
  current_balance: string;
  status: "active" | "inactive";
};

const EMPTY: FormState = {
  company_id: "",
  bank_name: "",
  account_number: "",
  account_holder: "",
  label: "",
  current_balance: "0",
  status: "active",
};

export function BankAccountFormModal({ open, onOpenChange, account }: Props) {
  const addAccount = useStore((s) => s.addCompanyBankAccount);
  const updateAccount = useStore((s) => s.updateCompanyBankAccount);
  const isEdit = !!account;

  const [form, setForm] = useState<FormState>(EMPTY);

  useEffect(() => {
    if (open) {
      if (account) {
        setForm({
          company_id: String(account.company_id),
          bank_name: account.bank_name,
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
  }, [open, account]);

  const errors = {
    company_id: !form.company_id ? "Required" : null,
    bank_name: !form.bank_name ? "Required" : null,
    account_number: !form.account_number.trim() ? "Required" : null,
    account_holder: !form.account_holder.trim() ? "Required" : null,
    current_balance:
      form.current_balance === "" || isNaN(Number(form.current_balance))
        ? "Enter a valid amount"
        : null,
  };
  const isValid = Object.values(errors).every((e) => e === null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    const payload = {
      company_id: Number(form.company_id),
      bank_name: form.bank_name as BankName,
      account_number: form.account_number.trim(),
      account_holder: form.account_holder.trim(),
      label: form.label.trim() || undefined,
      current_balance: Number(form.current_balance),
      status: form.status,
    };

    if (isEdit && account) {
      updateAccount(account.account_id, payload);
      toast.success("Bank account updated");
    } else {
      addAccount(payload);
      toast.success("Bank account added");
    }
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
              Company-owned receiving account for player deposits
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 p-5">
          <div className="space-y-1.5">
            <Label>
              Company <span className="text-rose-600">*</span>
            </Label>
            <Select
              value={form.company_id}
              onValueChange={(v) => update("company_id", v ?? "")}
            >
              <SelectTrigger className="h-8 w-full" aria-invalid={!!errors.company_id}>
                <SelectValue placeholder="Select company" />
              </SelectTrigger>
              <SelectContent>
                {COMPANIES.map((c) => (
                  <SelectItem key={c.company_id} value={String(c.company_id)}>
                    {c.company_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>
                Bank <span className="text-rose-600">*</span>
              </Label>
              <Select
                value={form.bank_name}
                onValueChange={(v) => update("bank_name", v ?? "")}
              >
                <SelectTrigger className="h-8 w-full" aria-invalid={!!errors.bank_name}>
                  <SelectValue placeholder="Select bank" />
                </SelectTrigger>
                <SelectContent>
                  {BANKS.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
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
            <div className="space-y-1.5">
              <Label htmlFor="ba-bal">
                {isEdit ? "Current balance (RM)" : "Opening balance (RM)"}
              </Label>
              <Input
                id="ba-bal"
                type="number"
                step="0.01"
                value={form.current_balance}
                onChange={(e) => update("current_balance", e.target.value)}
                aria-invalid={!!errors.current_balance}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) =>
                  update("status", (v as "active" | "inactive") ?? "active")
                }
              >
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t bg-muted/30 -mx-5 -mb-5 px-5 py-3 mt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid} className="cursor-pointer">
              {isEdit ? "Save changes" : "Add bank account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

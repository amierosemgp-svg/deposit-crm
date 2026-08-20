"use client";

import { useMemo, useState } from "react";
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
  login_company_id: string;
  login_id: string;
  login_password: string;
  login_pin: string;
  device_id: string;
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
  login_company_id: "",
  login_id: "",
  login_password: "",
  login_pin: "",
  device_id: "",
  current_balance: "0",
  status: "active",
};

const ROLE_HINTS: Record<FormState["role"], string> = {
  deposit:
    "Collection account — receives player deposits and is watched by the bank agent.",
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

  // Re-seed the form whenever the modal opens (state-during-render reset).
  const [prevResetKey, setPrevResetKey] = useState("");
  const resetKey = `${open}:${account?.account_id ?? "new"}`;
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
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
          login_company_id: account.login_company_id ?? "",
          login_id: account.login_id ?? "",
          login_password: account.login_password ?? "",
          login_pin: account.login_pin ?? "",
          device_id: account.device_id ?? "",
          current_balance: String(account.current_balance),
          status: account.status,
        });
      } else {
        setForm(EMPTY);
      }
    }
  }

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
        login_company_id: form.login_company_id.trim() || null,
        login_id: form.login_id.trim() || null,
        login_password: form.login_password.trim() || null,
        login_pin: form.login_pin.trim() || null,
        device_id: form.device_id.trim() || null,
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
        login_company_id: form.login_company_id.trim() || undefined,
        login_id: form.login_id.trim() || undefined,
        login_password: form.login_password.trim() || undefined,
        login_pin: form.login_pin.trim() || undefined,
        device_id: form.device_id.trim() || undefined,
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
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden gap-0 flex max-h-[calc(100dvh-2rem)] flex-col">
        <DialogTitle className="sr-only">
          {isEdit ? "Edit bank account" : "Add bank account"}
        </DialogTitle>

        <div className="flex shrink-0 items-center gap-3 border-b px-5 py-4">
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

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-5">
            <div className="space-y-1.5">
              <Label>
                Entity <span className="text-rose-600 dark:text-rose-400">*</span>
              </Label>
              <Select
                value={form.entity_id}
                onValueChange={(v) => update("entity_id", v ?? "")}
                items={eligibleEntities.map((e) => ({
                  value: String(e.entity_id),
                  label: `${e.name} (${e.entity_type === "leader" ? "Leader" : "Company"})`,
                }))}
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
                Role <span className="text-rose-600 dark:text-rose-400">*</span>
              </Label>
              <Select
                value={form.role}
                onValueChange={(v) =>
                  update("role", (v as "deposit" | "withdrawal") ?? "deposit")
                }
                items={{
                  deposit: "Deposit · Collection",
                  withdrawal: "Withdrawal · Payout",
                }}
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
                  Bank <span className="text-rose-600 dark:text-rose-400">*</span>
                </Label>
                <Select
                  value={form.bank_select}
                  onValueChange={(v) => update("bank_select", v ?? "")}
                  items={[
                    ...banks.map((b) => ({ value: b, label: b })),
                    { value: OTHER_BANK, label: "Other…" },
                  ]}
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
                  Bank name <span className="text-rose-600 dark:text-rose-400">*</span>
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
                Account number <span className="text-rose-600 dark:text-rose-400">*</span>
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
                Account holder <span className="text-rose-600 dark:text-rose-400">*</span>
              </Label>
              <Input
                id="ba-holder"
                value={form.account_holder}
                onChange={(e) => update("account_holder", e.target.value)}
                placeholder="Leader Alpha Sdn Bhd"
                aria-invalid={!!errors.account_holder}
              />
            </div>

            <div className="rounded-md border bg-muted/20 p-3 space-y-2.5">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Online banking credentials
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Used by the AI agent to log in and query this account.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ba-company-id" className="text-[11px]">
                  Company ID
                </Label>
                <Input
                  id="ba-company-id"
                  value={form.login_company_id}
                  onChange={(e) => update("login_company_id", e.target.value)}
                  placeholder="Enterprise accounts only — e.g. CLCMIKE01"
                  autoComplete="off"
                  className="h-8"
                />
                <p className="text-[10px] text-muted-foreground">
                  Business banking asks for this before the user ID. Leave empty
                  for a personal account.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="ba-login-id" className="text-[11px]">
                    Login ID
                  </Label>
                  <Input
                    id="ba-login-id"
                    value={form.login_id}
                    onChange={(e) => update("login_id", e.target.value)}
                    placeholder="Online banking user ID"
                    autoComplete="off"
                    className="h-8"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ba-login-pw" className="text-[11px]">
                    Password
                  </Label>
                  <Input
                    id="ba-login-pw"
                    value={form.login_password}
                    onChange={(e) => update("login_password", e.target.value)}
                    placeholder="Password"
                    autoComplete="off"
                    className="h-8 font-mono"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ba-login-pin" className="text-[11px]">
                  PIN
                </Label>
                <Input
                  id="ba-login-pin"
                  value={form.login_pin}
                  onChange={(e) => update("login_pin", e.target.value)}
                  placeholder="Transaction / approval PIN"
                  autoComplete="off"
                  inputMode="numeric"
                  className="h-8 font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ba-device-id" className="text-[11px]">
                  Device ID
                </Label>
                <Input
                  id="ba-device-id"
                  value={form.device_id}
                  onChange={(e) => update("device_id", e.target.value)}
                  placeholder="e.g. pixel-7a-kl-03"
                  autoComplete="off"
                  className="h-8 font-mono"
                />
                <p className="text-[10px] text-muted-foreground">
                  The device this account&apos;s banking app is bound to. The agent
                  also sets this itself as it picks the account up.
                </p>
              </div>
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
                  items={{ active: "Active", inactive: "Inactive" }}
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

          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
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

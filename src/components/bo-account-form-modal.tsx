"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";
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
import type { ProviderBoAccount } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: ProviderBoAccount | null;
};

type FormState = {
  company_entity_id: string;
  game_name: string;
  bo_username: string;
  bo_url: string;
  bo_password: string;
  bo_pin: string;
  bo_label: string;
  current_credit: string;
  status: "active" | "inactive";
  notes: string;
};

const EMPTY: FormState = {
  company_entity_id: "",
  game_name: "",
  bo_username: "",
  bo_url: "",
  bo_password: "",
  bo_pin: "",
  bo_label: "",
  current_credit: "0",
  status: "active",
  notes: "",
};

export function BoAccountFormModal({ open, onOpenChange, account }: Props) {
  const addAccount = useStore((s) => s.addBoAccount);
  const updateAccount = useStore((s) => s.updateBoAccount);
  const companies = useStore((s) => s.companies)();
  const games = useStore((s) => s.games)();
  const me = useStore((s) => s.me);
  const isEdit = !!account;

  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);

  const eligibleCompanies = useMemo(
    () =>
      companies.filter(
        (c) =>
          c.status === "active" &&
          (!me ||
            me.ownedEntityIds === null ||
            me.ownedEntityIds.includes(c.company_id)),
      ),
    [companies, me],
  );

  // Re-seed the form whenever the modal opens (state-during-render reset).
  const [prevResetKey, setPrevResetKey] = useState("");
  const resetKey = `${open}:${account?.bo_account_id ?? "new"}`;
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    if (open) {
      if (account) {
        setForm({
          company_entity_id: String(account.company_entity_id),
          game_name: account.game_name,
          bo_username: account.bo_username,
          bo_url: account.bo_url ?? "",
          bo_password: account.bo_password ?? "",
          bo_pin: account.bo_pin ?? "",
          bo_label: account.bo_label ?? "",
          current_credit: String(account.current_credit),
          status: account.status,
          notes: account.notes ?? "",
        });
      } else {
        setForm(EMPTY);
      }
    }
  }

  const errors = {
    company_entity_id: !form.company_entity_id ? "Required" : null,
    game_name: !form.game_name ? "Required" : null,
    bo_username: !form.bo_username.trim() ? "Required" : null,
    bo_password: !form.bo_password.trim() ? "Required" : null,
    current_credit:
      !isEdit &&
      (form.current_credit === "" ||
        isNaN(Number(form.current_credit)) ||
        Number(form.current_credit) < 0)
        ? "Enter a non-negative number"
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
      result = await updateAccount(account.bo_account_id, {
        company_entity_id: Number(form.company_entity_id),
        game_name: form.game_name,
        bo_username: form.bo_username.trim(),
        bo_url: form.bo_url.trim() || null,
        bo_password: form.bo_password.trim(),
        bo_pin: form.bo_pin.trim() || null,
        bo_label: form.bo_label.trim() || undefined,
        status: form.status,
        notes: form.notes.trim() || undefined,
      });
    } else {
      result = await addAccount({
        company_entity_id: Number(form.company_entity_id),
        game_name: form.game_name,
        bo_username: form.bo_username.trim(),
        bo_url: form.bo_url.trim() || undefined,
        bo_password: form.bo_password.trim(),
        bo_pin: form.bo_pin.trim() || undefined,
        bo_label: form.bo_label.trim() || undefined,
        current_credit: Number(form.current_credit),
        status: form.status,
        notes: form.notes.trim() || undefined,
      });
    }
    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.error ?? "Could not save BO account");
      return;
    }
    toast.success(isEdit ? "BO account updated" : "BO account added");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden gap-0 flex max-h-[calc(100dvh-2rem)] flex-col">
        <DialogTitle className="sr-only">
          {isEdit ? "Edit BO account" : "Add BO account"}
        </DialogTitle>

        <div className="flex shrink-0 items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <KeyRound className="h-4.5 w-4.5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold leading-tight">
              {isEdit ? "Edit BO account" : "Add BO account"}
            </h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              Game-provider back-office login that holds wholesale credit
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>
                  Company <span className="text-rose-600">*</span>
                </Label>
                <Select
                  value={form.company_entity_id}
                  onValueChange={(v) => update("company_entity_id", v ?? "")}
                  items={eligibleCompanies.map((c) => ({
                    value: String(c.company_id),
                    label: c.company_name,
                  }))}
                >
                  <SelectTrigger
                    className="h-8 w-full cursor-pointer"
                    aria-invalid={!!errors.company_entity_id}
                  >
                    <SelectValue placeholder="Select company" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleCompanies.length === 0 && (
                      <div className="px-3 py-2 text-[12px] text-muted-foreground">
                        No companies available
                      </div>
                    )}
                    {eligibleCompanies.map((c) => (
                      <SelectItem
                        key={c.company_id}
                        value={String(c.company_id)}
                        className="cursor-pointer"
                      >
                        {c.company_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>
                  Game <span className="text-rose-600">*</span>
                </Label>
                <Select
                  value={form.game_name}
                  onValueChange={(v) => update("game_name", v ?? "")}
                >
                  <SelectTrigger
                    className="h-8 w-full cursor-pointer"
                    aria-invalid={!!errors.game_name}
                  >
                    <SelectValue placeholder="Select game" />
                  </SelectTrigger>
                  <SelectContent>
                    {games.map((g) => (
                      <SelectItem key={g} value={g} className="cursor-pointer">
                        {g}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="bo-username">
                  BO username <span className="text-rose-600">*</span>
                </Label>
                <Input
                  id="bo-username"
                  value={form.bo_username}
                  onChange={(e) => update("bo_username", e.target.value)}
                  placeholder="alpha_mega_master"
                  aria-invalid={!!errors.bo_username}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bo-label">Label</Label>
                <Input
                  id="bo-label"
                  value={form.bo_label}
                  onChange={(e) => update("bo_label", e.target.value)}
                  placeholder="Master Agent, Sub A…"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bo-url">BO URL</Label>
              <Input
                id="bo-url"
                value={form.bo_url}
                onChange={(e) => update("bo_url", e.target.value)}
                placeholder="https://bo.mega888.com/login"
                inputMode="url"
                autoComplete="off"
              />
              <p className="text-[10px] text-muted-foreground">
                Back-office login page. The bot reads it from here — if the
                provider changes the URL, just update this field.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="bo-password">
                  BO password <span className="text-rose-600">*</span>
                </Label>
                <Input
                  id="bo-password"
                  value={form.bo_password}
                  onChange={(e) => update("bo_password", e.target.value)}
                  placeholder="Back-office login password"
                  autoComplete="off"
                  aria-invalid={!!errors.bo_password}
                  className="font-mono"
                />
                <p className="text-[10px] text-muted-foreground">
                  The bot uses this to log in and assign game credit.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bo-pin">PIN (optional)</Label>
                <Input
                  id="bo-pin"
                  value={form.bo_pin}
                  onChange={(e) => update("bo_pin", e.target.value)}
                  placeholder="Approval PIN, if any"
                  autoComplete="off"
                  inputMode="numeric"
                  className="font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {!isEdit ? (
                <div className="space-y-1.5">
                  <Label htmlFor="bo-credit">Opening credit</Label>
                  <Input
                    id="bo-credit"
                    type="number"
                    step="0.01"
                    value={form.current_credit}
                    onChange={(e) => update("current_credit", e.target.value)}
                    aria-invalid={!!errors.current_credit}
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label>Current credit</Label>
                  <div className="flex h-8 items-center rounded-md border bg-muted/30 px-2.5 text-sm tabular-nums">
                    {account?.current_credit.toLocaleString("en-MY", {
                      minimumFractionDigits: 2,
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Use Top Up / Deduct for tracked credit changes.
                  </p>
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

            <div className="space-y-1.5">
              <Label htmlFor="bo-notes">Notes</Label>
              <textarea
                id="bo-notes"
                value={form.notes}
                onChange={(e) => update("notes", e.target.value)}
                rows={2}
                placeholder="Internal notes about this BO account"
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 resize-none"
              />
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
              {isEdit ? "Save changes" : "Add BO account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

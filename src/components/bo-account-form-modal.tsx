"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
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
import { GAMES, type GameName, type ProviderBoAccount } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: ProviderBoAccount | null;
};

type FormState = {
  company_id: string;
  game_name: string;
  bo_username: string;
  bo_label: string;
  current_credit: string;
  status: "active" | "inactive";
  notes: string;
};

const EMPTY: FormState = {
  company_id: "",
  game_name: "",
  bo_username: "",
  bo_label: "",
  current_credit: "0",
  status: "active",
  notes: "",
};

export function BoAccountFormModal({ open, onOpenChange, account }: Props) {
  const addAccount = useStore((s) => s.addProviderBoAccount);
  const updateAccount = useStore((s) => s.updateProviderBoAccount);
  const isEdit = !!account;

  const [form, setForm] = useState<FormState>(EMPTY);

  useEffect(() => {
    if (open) {
      if (account) {
        setForm({
          company_id: String(account.company_id),
          game_name: account.game_name,
          bo_username: account.bo_username,
          bo_label: account.bo_label ?? "",
          current_credit: String(account.current_credit),
          status: account.status,
          notes: account.notes ?? "",
        });
      } else {
        setForm(EMPTY);
      }
    }
  }, [open, account]);

  const errors = {
    company_id: !form.company_id ? "Required" : null,
    game_name: !form.game_name ? "Required" : null,
    bo_username: !form.bo_username.trim() ? "Required" : null,
    current_credit:
      form.current_credit === "" ||
      isNaN(Number(form.current_credit)) ||
      Number(form.current_credit) < 0
        ? "Enter a non-negative number"
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
      game_name: form.game_name as GameName,
      bo_username: form.bo_username.trim(),
      bo_label: form.bo_label.trim() || undefined,
      current_credit: Number(form.current_credit),
      status: form.status,
      notes: form.notes.trim() || undefined,
    };

    if (isEdit && account) {
      updateAccount(account.bo_account_id, payload);
      toast.success("BO account updated");
    } else {
      addAccount(payload);
      toast.success("BO account added");
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">
          {isEdit ? "Edit BO account" : "Add BO account"}
        </DialogTitle>

        <div className="flex items-center gap-3 border-b px-5 py-4">
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

        <form onSubmit={handleSubmit} className="space-y-3.5 p-5">
          <div className="grid grid-cols-2 gap-3">
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
            <div className="space-y-1.5">
              <Label>
                Game <span className="text-rose-600">*</span>
              </Label>
              <Select
                value={form.game_name}
                onValueChange={(v) => update("game_name", v ?? "")}
              >
                <SelectTrigger className="h-8 w-full" aria-invalid={!!errors.game_name}>
                  <SelectValue placeholder="Select game" />
                </SelectTrigger>
                <SelectContent>
                  {GAMES.map((g) => (
                    <SelectItem key={g} value={g}>
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

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bo-credit">
                {isEdit ? "Current credit" : "Opening credit"}
              </Label>
              <Input
                id="bo-credit"
                type="number"
                step="0.01"
                value={form.current_credit}
                onChange={(e) => update("current_credit", e.target.value)}
                aria-invalid={!!errors.current_credit}
              />
              {isEdit && (
                <p className="text-[10px] text-muted-foreground">
                  For tracked credit changes, use Top Up / Deduct instead.
                </p>
              )}
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
              {isEdit ? "Save changes" : "Add BO account"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

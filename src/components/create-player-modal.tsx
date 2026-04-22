"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { CheckCircle2, UserPlus } from "lucide-react";
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
import { COMPANIES, PLAYERS } from "@/lib/mock-data";
import { useStore } from "@/lib/store";
import { BANKS, type BankName } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type FormState = {
  full_name: string;
  username: string;
  telegram_username: string;
  contact_number: string;
  wechat_id: string;
  company_id: string;
  bank_name: string;
  bank_account_number: string;
  bank_account_holder: string;
  notes: string;
};

const EMPTY: FormState = {
  full_name: "",
  username: "",
  telegram_username: "",
  contact_number: "",
  wechat_id: "",
  company_id: "",
  bank_name: "",
  bank_account_number: "",
  bank_account_holder: "",
  notes: "",
};

export function CreatePlayerModal({ open, onOpenChange }: Props) {
  const importPlayers = useStore((s) => s.importPlayers);
  const importedPlayers = useStore((s) => s.importedPlayers);

  const [form, setForm] = useState<FormState>(EMPTY);
  const [phase, setPhase] = useState<"input" | "done">("input");
  const [createdName, setCreatedName] = useState("");

  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setForm(EMPTY);
        setPhase("input");
        setCreatedName("");
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  const usernameTaken = useMemo(() => {
    const u = form.username.trim().toLowerCase();
    if (!u) return false;
    return (
      PLAYERS.some((p) => p.username.toLowerCase() === u) ||
      importedPlayers.some((p) => p.username.toLowerCase() === u)
    );
  }, [form.username, importedPlayers]);

  const errors = {
    full_name: !form.full_name.trim() ? "Required" : null,
    username: !form.username.trim()
      ? "Required"
      : usernameTaken
        ? "Username already exists"
        : null,
    telegram_username: !form.telegram_username.trim() ? "Required" : null,
    company_id: !form.company_id ? "Required" : null,
  };
  const isValid = Object.values(errors).every((e) => e === null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    const tg = form.telegram_username.trim();
    const acctNum = form.bank_account_number.trim();
    const created = importPlayers([
      {
        full_name: form.full_name.trim(),
        username: form.username.trim(),
        telegram_username: tg.startsWith("@") ? tg : `@${tg}`,
        contact_number: form.contact_number.trim() || undefined,
        wechat_id: form.wechat_id.trim() || undefined,
        company_id: Number(form.company_id),
        bank_name: (form.bank_name as BankName) || undefined,
        bank_account_number: acctNum || undefined,
        bank_account_holder:
          form.bank_account_holder.trim() ||
          (acctNum ? form.full_name.trim() : undefined),
        notes: form.notes.trim() || undefined,
      },
    ]);
    setCreatedName(created[0]?.full_name ?? "Player");
    setPhase("done");
    toast.success(`Player "${created[0]?.full_name}" created`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">Create player</DialogTitle>

        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <UserPlus className="h-4.5 w-4.5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold leading-tight">
              Create player
            </h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              Add a new player to the CRM
            </p>
          </div>
        </div>

        {phase === "input" && (
          <form onSubmit={handleSubmit} className="space-y-3.5 p-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cp-fullname">
                  Full name <span className="text-rose-600">*</span>
                </Label>
                <Input
                  id="cp-fullname"
                  value={form.full_name}
                  onChange={(e) => update("full_name", e.target.value)}
                  placeholder="Tan Hong Ming"
                  aria-invalid={!!errors.full_name}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cp-username">
                  Username <span className="text-rose-600">*</span>
                </Label>
                <Input
                  id="cp-username"
                  value={form.username}
                  onChange={(e) => update("username", e.target.value)}
                  placeholder="thm_tan"
                  aria-invalid={!!errors.username}
                />
                {errors.username === "Username already exists" && (
                  <p className="text-[11px] text-rose-600">
                    This username is already taken
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cp-tg">
                  Telegram <span className="text-rose-600">*</span>
                </Label>
                <Input
                  id="cp-tg"
                  value={form.telegram_username}
                  onChange={(e) => update("telegram_username", e.target.value)}
                  placeholder="@thm_tan"
                  aria-invalid={!!errors.telegram_username}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cp-wechat">WeChat ID</Label>
                <Input
                  id="cp-wechat"
                  value={form.wechat_id}
                  onChange={(e) => update("wechat_id", e.target.value)}
                  placeholder="thmtan_wx"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cp-phone">Contact number</Label>
                <Input
                  id="cp-phone"
                  value={form.contact_number}
                  onChange={(e) => update("contact_number", e.target.value)}
                  placeholder="+60 12-345 6789"
                />
              </div>
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
            </div>

            <div className="rounded-md border bg-muted/20 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Bank account on file
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Optional · used to auto-match incoming deposits
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Bank</Label>
                  <Select
                    value={form.bank_name}
                    onValueChange={(v) => update("bank_name", v ?? "")}
                  >
                    <SelectTrigger className="h-8 w-full">
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
                  <Label htmlFor="cp-acct-num">Account number</Label>
                  <Input
                    id="cp-acct-num"
                    value={form.bank_account_number}
                    onChange={(e) =>
                      update("bank_account_number", e.target.value)
                    }
                    placeholder="5128 4471 9023"
                    inputMode="numeric"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cp-acct-holder">Account holder name</Label>
                <Input
                  id="cp-acct-holder"
                  value={form.bank_account_holder}
                  onChange={(e) =>
                    update("bank_account_holder", e.target.value)
                  }
                  placeholder={form.full_name || "Defaults to full name"}
                />
                <p className="text-[10px] text-muted-foreground">
                  Leave blank if same as full name
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cp-notes">Internal notes</Label>
              <textarea
                id="cp-notes"
                value={form.notes}
                onChange={(e) => update("notes", e.target.value)}
                placeholder="VIP, prefers Mega888, etc."
                rows={2}
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
              <Button
                type="submit"
                disabled={!isValid}
                className="cursor-pointer"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Create player
              </Button>
            </div>
          </form>
        )}

        {phase === "done" && (
          <div className="space-y-4 p-8 text-center">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", damping: 12, stiffness: 220 }}
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600"
            >
              <CheckCircle2 className="h-8 w-8" />
            </motion.div>
            <div>
              <h3 className="text-lg font-semibold">{createdName} added</h3>
              <p className="mt-1 text-[12px] text-muted-foreground">
                The new player is now visible in the players list
              </p>
            </div>
            <div className="flex justify-center gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setForm(EMPTY);
                  setPhase("input");
                  setCreatedName("");
                }}
                className="cursor-pointer"
              >
                Add another
              </Button>
              <Button
                onClick={() => onOpenChange(false)}
                className="cursor-pointer"
              >
                Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

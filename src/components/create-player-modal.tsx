"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  CheckCircle2,
  UserPlus,
  Plus,
  Trash2,
  Landmark,
  Gamepad2,
} from "lucide-react";
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
import {
  BANKS,
  GAMES,
  type BankName,
  type GameName,
  type PlayerBankAccount,
  type PlayerGameAccount,
} from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type BankRow = { bank_name: string; account_number: string; account_holder: string };
type GameRow = { game_name: string; game_username: string };

type FormState = {
  full_name: string;
  username: string;
  telegram_username: string;
  contact_number: string;
  wechat_id: string;
  company_id: string;
  bank_accounts: BankRow[];
  game_accounts: GameRow[];
  notes: string;
};

const EMPTY: FormState = {
  full_name: "",
  username: "",
  telegram_username: "",
  contact_number: "",
  wechat_id: "",
  company_id: "",
  bank_accounts: [],
  game_accounts: [],
  notes: "",
};

const FORM_ID = "create-player-form";

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
    bank_accounts: form.bank_accounts.some(
      (b) => !b.bank_name || !b.account_number.trim(),
    )
      ? "Fill bank and account number for each bank row, or remove it"
      : null,
    game_accounts: form.game_accounts.some(
      (g) => !g.game_name || !g.game_username.trim(),
    )
      ? "Fill game and username for each game row, or remove it"
      : null,
  };
  const isValid = Object.values(errors).every((e) => e === null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function addBank() {
    setForm((f) => ({
      ...f,
      bank_accounts: [
        ...f.bank_accounts,
        { bank_name: "", account_number: "", account_holder: "" },
      ],
    }));
  }
  function updateBank(idx: number, patch: Partial<BankRow>) {
    setForm((f) => ({
      ...f,
      bank_accounts: f.bank_accounts.map((b, i) =>
        i === idx ? { ...b, ...patch } : b,
      ),
    }));
  }
  function removeBank(idx: number) {
    setForm((f) => ({
      ...f,
      bank_accounts: f.bank_accounts.filter((_, i) => i !== idx),
    }));
  }

  function addGame() {
    setForm((f) => ({
      ...f,
      game_accounts: [...f.game_accounts, { game_name: "", game_username: "" }],
    }));
  }
  function updateGame(idx: number, patch: Partial<GameRow>) {
    setForm((f) => ({
      ...f,
      game_accounts: f.game_accounts.map((g, i) =>
        i === idx ? { ...g, ...patch } : g,
      ),
    }));
  }
  function removeGame(idx: number) {
    setForm((f) => ({
      ...f,
      game_accounts: f.game_accounts.filter((_, i) => i !== idx),
    }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    const tg = form.telegram_username.trim();
    const fullName = form.full_name.trim();

    const bankAccounts: PlayerBankAccount[] = form.bank_accounts.map((b) => ({
      bank_name: b.bank_name as BankName,
      account_number: b.account_number.trim(),
      account_holder: b.account_holder.trim() || fullName,
    }));
    const gameAccounts: PlayerGameAccount[] = form.game_accounts.map((g) => ({
      game_name: g.game_name as GameName,
      game_username: g.game_username.trim(),
    }));

    const created = importPlayers([
      {
        full_name: fullName,
        username: form.username.trim(),
        telegram_username: tg.startsWith("@") ? tg : `@${tg}`,
        contact_number: form.contact_number.trim() || undefined,
        wechat_id: form.wechat_id.trim() || undefined,
        company_id: Number(form.company_id),
        bank_accounts: bankAccounts.length ? bankAccounts : undefined,
        game_accounts: gameAccounts.length ? gameAccounts : undefined,
        notes: form.notes.trim() || undefined,
      },
    ]);
    setCreatedName(created[0]?.full_name ?? "Player");
    setPhase("done");
    toast.success(`Player "${created[0]?.full_name}" created`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl p-0 overflow-hidden gap-0 flex flex-col max-h-[88vh]">
        <DialogTitle className="sr-only">Create player</DialogTitle>

        <div className="flex items-center gap-3 border-b px-5 py-4 shrink-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <UserPlus className="h-4.5 w-4.5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold leading-tight">
              Create player
            </h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              Add a new player, with their bank and game accounts on file
            </p>
          </div>
        </div>

        {phase === "input" && (
          <>
            <div className="flex-1 overflow-y-auto">
              <form
                id={FORM_ID}
                onSubmit={handleSubmit}
                className="space-y-4 p-5"
              >
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
                      onChange={(e) =>
                        update("telegram_username", e.target.value)
                      }
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
                      <SelectTrigger
                        className="h-8 w-full"
                        aria-invalid={!!errors.company_id}
                      >
                        <SelectValue placeholder="Select company" />
                      </SelectTrigger>
                      <SelectContent>
                        {COMPANIES.map((c) => (
                          <SelectItem
                            key={c.company_id}
                            value={String(c.company_id)}
                          >
                            {c.company_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="rounded-md border bg-muted/20 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Bank accounts
                      </p>
                      {form.bank_accounts.length > 0 && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {form.bank_accounts.length}
                        </span>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={addBank}
                      className="cursor-pointer h-7 -my-1 -mr-1.5"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add bank
                    </Button>
                  </div>

                  {form.bank_accounts.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      None added — auto-matching incoming deposits will be
                      disabled for this player.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {form.bank_accounts.map((b, i) => (
                        <div
                          key={i}
                          className="rounded-md border bg-background p-2.5 space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                              Bank #{i + 1}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeBank(i)}
                              className="text-muted-foreground hover:text-rose-600 cursor-pointer"
                              aria-label="Remove bank"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <Select
                              value={b.bank_name}
                              onValueChange={(v) =>
                                updateBank(i, { bank_name: v ?? "" })
                              }
                            >
                              <SelectTrigger className="h-8 w-full">
                                <SelectValue placeholder="Select bank" />
                              </SelectTrigger>
                              <SelectContent>
                                {BANKS.map((bk) => (
                                  <SelectItem key={bk} value={bk}>
                                    {bk}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Input
                              value={b.account_number}
                              onChange={(e) =>
                                updateBank(i, { account_number: e.target.value })
                              }
                              placeholder="5128 4471 9023"
                              inputMode="numeric"
                            />
                          </div>
                          <Input
                            value={b.account_holder}
                            onChange={(e) =>
                              updateBank(i, { account_holder: e.target.value })
                            }
                            placeholder={
                              form.full_name
                                ? `Holder name (defaults to ${form.full_name})`
                                : "Holder name (defaults to full name)"
                            }
                          />
                        </div>
                      ))}
                      {errors.bank_accounts && (
                        <p className="text-[11px] text-rose-600">
                          {errors.bank_accounts}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="rounded-md border bg-muted/20 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Gamepad2 className="h-3.5 w-3.5 text-muted-foreground" />
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Game accounts
                      </p>
                      {form.game_accounts.length > 0 && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {form.game_accounts.length}
                        </span>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={addGame}
                      className="cursor-pointer h-7 -my-1 -mr-1.5"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add game
                    </Button>
                  </div>

                  {form.game_accounts.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      None linked — top-ups will require manual game username
                      entry.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {form.game_accounts.map((g, i) => (
                        <div
                          key={i}
                          className="grid grid-cols-[140px_1fr_auto] gap-2 items-center"
                        >
                          <Select
                            value={g.game_name}
                            onValueChange={(v) =>
                              updateGame(i, { game_name: v ?? "" })
                            }
                          >
                            <SelectTrigger className="h-8 w-full">
                              <SelectValue placeholder="Game" />
                            </SelectTrigger>
                            <SelectContent>
                              {GAMES.map((gm) => (
                                <SelectItem
                                  key={gm}
                                  value={gm}
                                  disabled={form.game_accounts.some(
                                    (other, j) =>
                                      j !== i && other.game_name === gm,
                                  )}
                                >
                                  {gm}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Input
                            value={g.game_username}
                            onChange={(e) =>
                              updateGame(i, { game_username: e.target.value })
                            }
                            placeholder="Game username / ID"
                          />
                          <button
                            type="button"
                            onClick={() => removeGame(i)}
                            className="text-muted-foreground hover:text-rose-600 cursor-pointer p-1"
                            aria-label="Remove game"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                      {errors.game_accounts && (
                        <p className="text-[11px] text-rose-600">
                          {errors.game_accounts}
                        </p>
                      )}
                    </div>
                  )}
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
              </form>
            </div>

            <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3 shrink-0">
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
                form={FORM_ID}
                disabled={!isValid}
                className="cursor-pointer"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Create player
              </Button>
            </div>
          </>
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

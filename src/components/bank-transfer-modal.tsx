"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowRight,
  ArrowRightLeft,
  CheckCircle2,
  Info,
  Loader2,
} from "lucide-react";
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
import type { BankAccount } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultFromAccountId?: number | null;
};

export function BankTransferModal({
  open,
  onOpenChange,
  defaultFromAccountId,
}: Props) {
  const accounts = useStore((s) => s.bankAccounts);
  const me = useStore((s) => s.me);
  const entityName = useStore((s) => s.entityName);
  const createTransfer = useStore((s) => s.createBankTransfer);

  const activeAccounts = useMemo(
    () => accounts.filter((a) => a.status === "active"),
    [accounts],
  );

  // From: only accounts belonging to entities the user manages
  const fromAccounts = useMemo(
    () =>
      activeAccounts.filter(
        (a) =>
          !!me &&
          (me.ownedEntityIds === null || me.ownedEntityIds.includes(a.entity_id)),
      ),
    [activeAccounts, me],
  );

  const [fromId, setFromId] = useState<string>("");
  const [toId, setToId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [skipBot, setSkipBot] = useState(false);
  const [phase, setPhase] = useState<"input" | "submitting" | "success">("input");

  useEffect(() => {
    if (open) {
      setFromId(defaultFromAccountId ? String(defaultFromAccountId) : "");
      setToId("");
      setAmount("");
      setReference("");
      setNotes("");
      setSkipBot(false);
      setPhase("input");
    }
  }, [open, defaultFromAccountId]);

  const fromAccount = fromAccounts.find((a) => a.account_id === Number(fromId));
  const toAccount = activeAccounts.find((a) => a.account_id === Number(toId));
  const amt = Number(amount) || 0;

  // To: all visible active accounts except the selected source, grouped by entity
  const toGroups = useMemo(() => {
    const candidates = activeAccounts.filter(
      (a) => String(a.account_id) !== fromId,
    );
    const map = new Map<number, BankAccount[]>();
    for (const a of candidates) {
      const list = map.get(a.entity_id) ?? [];
      list.push(a);
      map.set(a.entity_id, list);
    }
    return Array.from(map.entries()).map(([entityId, accts]) => ({
      entityId,
      accounts: accts,
    }));
  }, [activeAccounts, fromId]);

  const validation = (() => {
    if (!fromAccount) return "Select source account";
    if (!toAccount) return "Select destination account";
    if (fromAccount.account_id === toAccount.account_id)
      return "Source and destination must differ";
    if (amt <= 0) return "Enter an amount greater than 0";
    if (amt > fromAccount.current_balance) return "Exceeds source balance";
    return null;
  })();
  const canSubmit = !validation && phase === "input";

  async function handleSubmit() {
    if (!canSubmit || !fromAccount || !toAccount) return;
    setPhase("submitting");
    const result = await createTransfer({
      fromAccountId: fromAccount.account_id,
      toAccountId: toAccount.account_id,
      amount: amt,
      reference: reference || undefined,
      notes: notes || undefined,
      skip_bot: skipBot,
    });
    if (result.ok) {
      setPhase("success");
      toast.success(
        `Transfer of ${formatRM(amt)} initiated — awaiting recipient confirmation`,
      );
    } else {
      toast.error(result.error ?? "Transfer failed");
      setPhase("input");
    }
  }

  function accountLabel(a: BankAccount) {
    return `${a.bank_name} · ${a.account_number}${a.label ? ` · ${a.label}` : ""}`;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">Transfer between bank accounts</DialogTitle>

        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ArrowRightLeft className="h-4.5 w-4.5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold leading-tight">
              Transfer between bank accounts
            </h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              Sender is debited immediately; recipient is credited on confirmation
            </p>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {(phase === "input" || phase === "submitting") && (
            <motion.div
              key="input"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-4 p-5"
            >
              <div className="flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2.5 text-[11px] text-blue-900 dark:text-blue-200">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" />
                <span>
                  Transfers require recipient confirmation and auto-confirm after the
                  configured window. Allowed: between companies under the same leader,
                  or from a leader to their own company.
                </span>
              </div>

              <div className="space-y-1.5">
                <Label>From</Label>
                <Select
                  value={fromId}
                  onValueChange={(v) => setFromId(v ?? "")}
                  items={fromAccounts.map((a) => ({
                    value: String(a.account_id),
                    label: `${accountLabel(a)} · ${entityName(a.entity_id)}`,
                  }))}
                >
                  <SelectTrigger className="h-9 w-full cursor-pointer">
                    <SelectValue placeholder="Source account" />
                  </SelectTrigger>
                  <SelectContent>
                    {fromAccounts.length === 0 && (
                      <div className="px-3 py-2 text-[12px] text-muted-foreground">
                        No active accounts you manage
                      </div>
                    )}
                    {fromAccounts.map((a) => (
                      <SelectItem
                        key={a.account_id}
                        value={String(a.account_id)}
                        className="cursor-pointer"
                      >
                        {accountLabel(a)} · {entityName(a.entity_id)} ·{" "}
                        {formatRM(a.current_balance)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fromAccount && (
                  <p className="text-[11px] text-muted-foreground">
                    Available:{" "}
                    <span className="font-medium text-foreground">
                      {formatRM(fromAccount.current_balance)}
                    </span>
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>To</Label>
                <Select
                  value={toId}
                  onValueChange={(v) => setToId(v ?? "")}
                  items={toGroups.flatMap((g) =>
                    g.accounts.map((a) => ({
                      value: String(a.account_id),
                      label: `${accountLabel(a)} · ${entityName(g.entityId)}`,
                    })),
                  )}
                >
                  <SelectTrigger className="h-9 w-full cursor-pointer">
                    <SelectValue placeholder="Destination account" />
                  </SelectTrigger>
                  <SelectContent>
                    {toGroups.length === 0 && (
                      <div className="px-3 py-2 text-[12px] text-muted-foreground">
                        No eligible destination accounts
                      </div>
                    )}
                    {toGroups.map((g) => (
                      <SelectGroup key={g.entityId}>
                        <SelectLabel>{entityName(g.entityId)}</SelectLabel>
                        {g.accounts.map((a) => (
                          <SelectItem
                            key={a.account_id}
                            value={String(a.account_id)}
                            className="cursor-pointer"
                          >
                            {accountLabel(a)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="bt-amount">Amount (RM)</Label>
                  <Input
                    id="bt-amount"
                    type="number"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    min={0}
                    max={fromAccount?.current_balance}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bt-ref">Reference (optional)</Label>
                  <Input
                    id="bt-ref"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="TRF-MBB-CIMB-…"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bt-notes">Notes (optional)</Label>
                <textarea
                  id="bt-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Top up payouts account, end-of-day consolidation, etc."
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 resize-none"
                />
              </div>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/40 p-3 select-none">
                <input
                  type="checkbox"
                  checked={skipBot}
                  onChange={(e) => setSkipBot(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-amber-600"
                />
                <span>
                  <span className="block text-sm font-medium">
                    Handle manually (skip agent)
                  </span>
                  <span className="block text-[11px] text-muted-foreground mt-0.5">
                    The agent won&apos;t act on this and it won&apos;t auto-confirm
                    after 24h — the recipient must Confirm or Reject it.
                  </span>
                </span>
              </label>

              {validation && fromId && toId && (
                <p className="text-[11px] text-rose-600 dark:text-rose-400">{validation}</p>
              )}

              <div className="flex items-center justify-end gap-2 border-t bg-muted/30 -mx-5 -mb-5 px-5 py-3 mt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={phase === "submitting"}
                  className="cursor-pointer"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="cursor-pointer"
                >
                  {phase === "submitting" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowRightLeft className="h-3.5 w-3.5" />
                  )}
                  Transfer {amt > 0 ? formatRM(amt) : ""}
                </Button>
              </div>
            </motion.div>
          )}

          {phase === "success" && (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", damping: 18, stiffness: 200 }}
              className="space-y-4 p-8 text-center"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", damping: 12, stiffness: 220 }}
                className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                <CheckCircle2 className="h-8 w-8" />
              </motion.div>
              <div>
                <h3 className="text-lg font-semibold">
                  {formatRM(amt)} transfer initiated
                </h3>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  The recipient must confirm before funds are credited. It will
                  auto-confirm after the configured window.
                </p>
                <div className="mt-3 inline-flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-[12px]">
                  <span className="font-medium">{fromAccount?.bank_name}</span>
                  <span className="font-mono text-muted-foreground">
                    {fromAccount?.account_number.slice(-4)}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{toAccount?.bank_name}</span>
                  <span className="font-mono text-muted-foreground">
                    {toAccount?.account_number.slice(-4)}
                  </span>
                </div>
              </div>
              <Button
                onClick={() => onOpenChange(false)}
                className="cursor-pointer"
              >
                Done
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

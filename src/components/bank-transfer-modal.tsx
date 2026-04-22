"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowRight,
  ArrowRightLeft,
  CheckCircle2,
  Loader2,
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
import { COMPANIES, CURRENT_USER } from "@/lib/mock-data";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultFromAccountId?: number | null;
};

const PROCESS_MS = 1800;

export function BankTransferModal({
  open,
  onOpenChange,
  defaultFromAccountId,
}: Props) {
  const accounts = useStore((s) => s.companyBankAccounts);
  const transfer = useStore((s) => s.transferBetweenCompanyAccounts);

  const activeAccounts = useMemo(
    () => accounts.filter((a) => a.status === "active"),
    [accounts],
  );

  const [fromId, setFromId] = useState<string>("");
  const [toId, setToId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [phase, setPhase] = useState<"input" | "processing" | "success">(
    "input",
  );
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (open) {
      setFromId(defaultFromAccountId ? String(defaultFromAccountId) : "");
      setToId("");
      setAmount("");
      setReference("");
      setNotes("");
      setPhase("input");
      setProgress(0);
    }
  }, [open, defaultFromAccountId]);

  const fromAccount = activeAccounts.find(
    (a) => a.account_id === Number(fromId),
  );
  const toAccount = activeAccounts.find((a) => a.account_id === Number(toId));
  const amt = Number(amount) || 0;

  const validation = (() => {
    if (!fromAccount) return "Select source account";
    if (!toAccount) return "Select destination account";
    if (fromAccount.account_id === toAccount.account_id)
      return "Source and destination must differ";
    if (amt <= 0) return "Enter an amount greater than 0";
    if (amt > fromAccount.current_balance) return "Exceeds source balance";
    return null;
  })();
  const canSubmit = !validation;

  function handleStart() {
    if (!canSubmit || !fromAccount || !toAccount) return;
    setPhase("processing");
    setProgress(0);

    const started = Date.now();
    const interval = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - started) / PROCESS_MS) * 100);
      setProgress(pct);
      if (pct >= 100) clearInterval(interval);
    }, 40);

    setTimeout(() => {
      const result = transfer({
        fromAccountId: fromAccount.account_id,
        toAccountId: toAccount.account_id,
        amount: amt,
        reference: reference || undefined,
        notes: notes || undefined,
        handledByUserId: CURRENT_USER.user_id,
      });
      if (result) {
        setPhase("success");
        toast.success(
          `Transferred ${formatRM(amt)} → ${toAccount.bank_name} ${toAccount.account_number.slice(-4)}`,
        );
      } else {
        toast.error("Transfer failed");
        setPhase("input");
      }
    }, PROCESS_MS);
  }

  function accountLabel(a: (typeof accounts)[number]) {
    const company = COMPANIES.find((c) => c.company_id === a.company_id);
    return `${a.bank_name} · ${a.account_number} · ${company?.company_name ?? ""}${a.label ? ` · ${a.label}` : ""}`;
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
              Move funds between company-owned accounts
            </p>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {phase === "input" && (
            <motion.div
              key="input"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-4 p-5"
            >
              <div className="space-y-1.5">
                <Label>From</Label>
                <Select value={fromId} onValueChange={(v) => setFromId(v ?? "")}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder="Source account" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeAccounts.map((a) => (
                      <SelectItem
                        key={a.account_id}
                        value={String(a.account_id)}
                      >
                        {accountLabel(a)} · {formatRM(a.current_balance)}
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
                <Select value={toId} onValueChange={(v) => setToId(v ?? "")}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder="Destination account" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeAccounts
                      .filter((a) => String(a.account_id) !== fromId)
                      .map((a) => (
                        <SelectItem
                          key={a.account_id}
                          value={String(a.account_id)}
                        >
                          {accountLabel(a)} · {formatRM(a.current_balance)}
                        </SelectItem>
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

              {validation && fromId && toId && (
                <p className="text-[11px] text-rose-600">{validation}</p>
              )}

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
                  type="button"
                  onClick={handleStart}
                  disabled={!canSubmit}
                  className="cursor-pointer"
                >
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  Transfer {amt > 0 ? formatRM(amt) : ""}
                </Button>
              </div>
            </motion.div>
          )}

          {phase === "processing" && (
            <motion.div
              key="processing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-5 p-8 text-center"
            >
              <div className="relative mx-auto h-16 w-16">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{
                    duration: 1.6,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                  className="absolute inset-0 rounded-full border-4 border-primary/10 border-t-primary"
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <ArrowRightLeft className="h-6 w-6 text-primary" />
                </div>
              </div>
              <div>
                <h3 className="text-base font-semibold">
                  Transferring {formatRM(amt)}…
                </h3>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {fromAccount?.bank_name} {fromAccount?.account_number} →{" "}
                  {toAccount?.bank_name} {toAccount?.account_number}
                </p>
              </div>
              <div className="mx-auto max-w-sm">
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ ease: "easeOut" }}
                    className="h-full bg-gradient-to-r from-primary to-primary/70"
                  />
                </div>
                <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                  <span>
                    <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                    Settling balances
                  </span>
                  <span className="font-mono">{Math.round(progress)}%</span>
                </div>
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
                className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600"
              >
                <CheckCircle2 className="h-8 w-8" />
              </motion.div>
              <div>
                <h3 className="text-lg font-semibold">
                  {formatRM(amt)} transferred
                </h3>
                <div className="mt-2 inline-flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-[12px]">
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

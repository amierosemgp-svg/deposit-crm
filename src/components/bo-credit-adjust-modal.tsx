"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle2,
  Coins,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CURRENT_USER, COMPANIES } from "@/lib/mock-data";
import { useStore } from "@/lib/store";
import type { ProviderBoAccount } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: ProviderBoAccount | null;
  defaultDirection?: "topup" | "deduct";
};

const QUICK_REASONS_TOPUP = [
  "Wholesale credit purchase from provider",
  "Provider settlement / weekly replenishment",
  "Sub-agent allocation",
];
const QUICK_REASONS_DEDUCT = [
  "Manual reconciliation — duplicated top-up",
  "Provider chargeback",
  "Credit moved to another BO account",
];

export function BoCreditAdjustModal({
  open,
  onOpenChange,
  account,
  defaultDirection = "topup",
}: Props) {
  const adjust = useStore((s) => s.adjustProviderBoCredit);

  const [direction, setDirection] = useState<"topup" | "deduct">(defaultDirection);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<"input" | "success">("input");
  const [appliedAmount, setAppliedAmount] = useState(0);

  useEffect(() => {
    if (open) {
      setDirection(defaultDirection);
      setAmount("");
      setReason("");
      setPhase("input");
      setAppliedAmount(0);
    }
  }, [open, defaultDirection]);

  const company = useMemo(
    () => (account ? COMPANIES.find((c) => c.company_id === account.company_id) : null),
    [account],
  );

  const amt = Number(amount) || 0;
  const signedAmt = direction === "topup" ? amt : -amt;
  const projected = account ? account.current_credit + signedAmt : 0;

  const validation = (() => {
    if (!account) return "No account selected";
    if (amt <= 0) return "Enter an amount greater than 0";
    if (direction === "deduct" && projected < 0) return "Would result in negative balance";
    if (!reason.trim()) return "A reason is required for the audit log";
    return null;
  })();
  const canSubmit = !validation;

  function handleSubmit() {
    if (!canSubmit || !account) return;
    const result = adjust({
      boAccountId: account.bo_account_id,
      amount: signedAmt,
      reason: reason.trim(),
      handledByUserId: CURRENT_USER.user_id,
    });
    if (!result) {
      toast.error("Adjustment failed");
      return;
    }
    setAppliedAmount(signedAmt);
    setPhase("success");
    toast.success(
      `${direction === "topup" ? "Topped up" : "Deducted"} ${amt.toLocaleString("en-MY")} credits`,
    );
  }

  if (!account) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md p-0">
          <DialogTitle className="sr-only">Adjust BO credit</DialogTitle>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">Adjust BO credit</DialogTitle>

        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Coins className="h-4.5 w-4.5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold leading-tight">
              Adjust BO credit
            </h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              {account.game_name} · {account.bo_username}
              {company ? ` · ${company.company_name}` : ""}
            </p>
          </div>
        </div>

        {phase === "input" && (
          <div className="space-y-4 p-5">
            <div className="rounded-md border bg-muted/20 px-3 py-2.5 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Current credit
              </span>
              <span className="text-base font-semibold tabular-nums">
                {account.current_credit.toLocaleString("en-MY", {
                  minimumFractionDigits: 2,
                })}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDirection("topup")}
                className={cn(
                  "rounded-md border px-3 py-2.5 text-sm font-medium flex items-center justify-center gap-2 cursor-pointer transition-colors",
                  direction === "topup"
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                    : "border-input hover:bg-muted/50",
                )}
              >
                <ArrowUpCircle className="h-4 w-4" />
                Top Up
              </button>
              <button
                type="button"
                onClick={() => setDirection("deduct")}
                className={cn(
                  "rounded-md border px-3 py-2.5 text-sm font-medium flex items-center justify-center gap-2 cursor-pointer transition-colors",
                  direction === "deduct"
                    ? "border-rose-500 bg-rose-50 text-rose-700"
                    : "border-input hover:bg-muted/50",
                )}
              >
                <ArrowDownCircle className="h-4 w-4" />
                Deduct
              </button>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ba-amount">Amount</Label>
              <Input
                id="ba-amount"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                min={0}
              />
              {amt > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  New balance:{" "}
                  <span
                    className={cn(
                      "font-medium tabular-nums",
                      projected < 0 && "text-rose-600",
                      projected >= 0 && "text-foreground",
                    )}
                  >
                    {projected.toLocaleString("en-MY", { minimumFractionDigits: 2 })}
                  </span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ba-reason">Reason</Label>
              <Input
                id="ba-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this adjustment being made?"
              />
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {(direction === "topup" ? QUICK_REASONS_TOPUP : QUICK_REASONS_DEDUCT).map(
                  (r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setReason(r)}
                      className="cursor-pointer rounded-full border bg-card px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    >
                      {r}
                    </button>
                  ),
                )}
              </div>
            </div>

            {validation && amt > 0 && (
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
                onClick={handleSubmit}
                disabled={!canSubmit}
                className={cn(
                  "cursor-pointer",
                  direction === "deduct" &&
                    "bg-rose-600 text-white hover:bg-rose-700",
                )}
              >
                {direction === "topup" ? (
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                ) : (
                  <ArrowDownCircle className="h-3.5 w-3.5" />
                )}
                {direction === "topup" ? "Top up" : "Deduct"} credit
              </Button>
            </div>
          </div>
        )}

        {phase === "success" && (
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
              <h3 className="text-lg font-semibold">
                {appliedAmount > 0 ? "Topped up" : "Deducted"}{" "}
                {Math.abs(appliedAmount).toLocaleString("en-MY", {
                  minimumFractionDigits: 2,
                })}{" "}
                credits
              </h3>
              <p className="mt-1 text-[12px] text-muted-foreground">
                New balance:{" "}
                <span className="font-medium text-foreground">
                  {(account.current_credit + appliedAmount).toLocaleString(
                    "en-MY",
                    { minimumFractionDigits: 2 },
                  )}
                </span>
              </p>
            </div>
            <Button onClick={() => onOpenChange(false)} className="cursor-pointer">
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

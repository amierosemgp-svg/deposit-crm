"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Loader2, Zap, Link2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { PLAYERS, CURRENT_USER } from "@/lib/mock-data";
import { formatRM } from "@/lib/format";
import { TelegramBubble } from "./telegram-bubble";

type Props = {
  depositId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const TOTAL_MS = 3500;

export function ApprovalFlowModal({ depositId, open, onOpenChange }: Props) {
  const deposit = useStore((s) =>
    depositId ? s.deposits.find((d) => d.deposit_id === depositId) : null,
  );
  const approveDeposit = useStore((s) => s.approveDeposit);
  const player = deposit ? PLAYERS.find((p) => p.player_id === deposit.player_id) : null;

  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<"processing" | "success">("processing");
  const [showBubble, setShowBubble] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProgress(0);
    setPhase("processing");
    setShowBubble(false);

    const started = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - started;
      const pct = Math.min(100, (elapsed / TOTAL_MS) * 100);
      setProgress(pct);
      if (pct >= 100) {
        clearInterval(interval);
      }
    }, 50);

    const done = setTimeout(() => {
      if (depositId) approveDeposit(depositId, CURRENT_USER.user_id);
      setPhase("success");
      setTimeout(() => setShowBubble(true), 600);
    }, TOTAL_MS);

    return () => {
      clearInterval(interval);
      clearTimeout(done);
    };
  }, [open, depositId, approveDeposit]);

  const reference = useMemo(
    () => `TOPUP-${100000 + Math.floor(Math.random() * 900000)}`,
    [open],
  );

  if (!deposit || !player) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden border-0">
        <DialogTitle className="sr-only">Processing deposit top-up</DialogTitle>

        <div className="relative bg-gradient-to-br from-background via-background to-muted/40">
          <div className="p-8">
            <AnimatePresence mode="wait">
              {phase === "processing" ? (
                <motion.div
                  key="processing"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-center space-y-6"
                >
                  <div className="relative mx-auto h-20 w-20">
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{
                        duration: 1.8,
                        repeat: Infinity,
                        ease: "linear",
                      }}
                      className="absolute inset-0 rounded-full border-4 border-primary/10 border-t-primary"
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Zap className="h-8 w-8 text-primary" />
                    </div>
                  </div>

                  <div>
                    <h2 className="text-xl font-semibold">Processing Deposit…</h2>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      Transferring{" "}
                      <span className="font-semibold text-foreground">
                        {formatRM(deposit.total_amount)}
                      </span>{" "}
                      to{" "}
                      <span className="font-semibold text-foreground">
                        {deposit.selected_game}
                      </span>{" "}
                      for{" "}
                      <span className="font-semibold text-foreground">
                        {player.full_name}
                      </span>
                    </p>
                  </div>

                  <div className="mx-auto max-w-md">
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                        transition={{ ease: "easeOut" }}
                        className="h-full bg-gradient-to-r from-primary to-primary/70"
                      />
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                      <span>
                        <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                        Connecting to {deposit.selected_game} API
                      </span>
                      <span className="font-mono">{Math.round(progress)}%</span>
                    </div>
                  </div>

                  <p className="text-xs text-amber-600">
                    Please wait — Do not close this window
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="success"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: "spring", damping: 18, stiffness: 200 }}
                  className="relative"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr,auto] gap-6 items-center">
                    <div className="text-center sm:text-left space-y-3">
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: "spring", damping: 10, stiffness: 220, delay: 0.1 }}
                        className="mx-auto sm:mx-0 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600"
                      >
                        <CheckCircle2 className="h-9 w-9" />
                      </motion.div>

                      <div>
                        <h2 className="text-xl font-semibold">
                          {formatRM(deposit.total_amount)} credited to {deposit.selected_game}!
                        </h2>
                        <p className="mt-1.5 text-sm text-muted-foreground">
                          Deposit {formatRM(deposit.deposit_amount)} + Bonus{" "}
                          {formatRM(deposit.bonus_amount)} ({deposit.bonus_percentage}%)
                        </p>
                      </div>

                      <div className="inline-flex items-center gap-1.5 rounded-md border bg-muted/30 px-2.5 py-1.5 text-[11px] font-mono text-muted-foreground">
                        <Link2 className="h-3 w-3" />
                        Ref: {reference}
                      </div>

                      <div className="flex gap-2 pt-2">
                        <Button onClick={() => onOpenChange(false)}>
                          Back to Deposits
                        </Button>
                      </div>
                    </div>

                    <div className="flex justify-center sm:justify-end">
                      <TelegramBubble
                        visible={showBubble}
                        playerName={player.full_name}
                        telegramUsername={player.telegram_username}
                        message={`✅ RM ${deposit.total_amount.toFixed(2)} credited to your ${deposit.selected_game} account. Good luck!`}
                      />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDownToLine,
  CheckCircle2,
  Loader2,
  Wallet,
  Gamepad2,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { PLAYERS, CURRENT_USER } from "@/lib/mock-data";
import { formatRM } from "@/lib/format";
import { AnimatedNumber } from "./animated-number";
import { TelegramBubble } from "./telegram-bubble";

type Props = {
  withdrawalId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const TOTAL_MS = 2600;

export function PullbackFlowModal({ withdrawalId, open, onOpenChange }: Props) {
  const withdrawal = useStore((s) =>
    withdrawalId ? s.withdrawals.find((w) => w.withdrawal_id === withdrawalId) : null,
  );
  const getBalanceLive = useStore((s) => s.getCreditBalance);
  const pullCredits = useStore((s) => s.pullCreditsForWithdrawal);

  const player = withdrawal
    ? PLAYERS.find((p) => p.player_id === withdrawal.player_id)
    : null;

  const [phase, setPhase] = useState<"processing" | "success">("processing");
  const [showBubble, setShowBubble] = useState(false);
  const [startBalance, setStartBalance] = useState(0);
  const [targetBalance, setTargetBalance] = useState(0);
  const [pulled, setPulled] = useState(0);
  const [gameBalanceDisplay, setGameBalanceDisplay] = useState(0);
  const [crmBalanceDisplay, setCrmBalanceDisplay] = useState(0);

  useEffect(() => {
    if (!open || !withdrawal) return;
    const bal = getBalanceLive(withdrawal.player_id, withdrawal.game_name);
    const pullAmt = Math.min(bal, withdrawal.requested_amount);
    setStartBalance(bal);
    setTargetBalance(bal - pullAmt);
    setPulled(pullAmt);
    setGameBalanceDisplay(bal);
    setCrmBalanceDisplay(0);
    setPhase("processing");
    setShowBubble(false);

    // Trigger countdown/up animation shortly after mount
    const tAnimate = setTimeout(() => {
      setGameBalanceDisplay(bal - pullAmt);
      setCrmBalanceDisplay(pullAmt);
    }, 350);

    const tDone = setTimeout(() => {
      pullCredits(withdrawal.withdrawal_id, CURRENT_USER.user_id);
      setPhase("success");
      setTimeout(() => setShowBubble(true), 500);
    }, TOTAL_MS);

    return () => {
      clearTimeout(tAnimate);
      clearTimeout(tDone);
    };
  }, [open, withdrawal, getBalanceLive, pullCredits]);

  if (!withdrawal || !player) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden border-0">
        <DialogTitle className="sr-only">Pulling credits from game</DialogTitle>

        <div className="bg-gradient-to-br from-background via-background to-muted/40 p-8">
          <AnimatePresence mode="wait">
            {phase === "processing" ? (
              <motion.div
                key="processing"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-6"
              >
                <div className="text-center space-y-1.5">
                  <h2 className="text-xl font-semibold">
                    Pulling credits from {withdrawal.game_name}…
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Moving {formatRM(pulled)} back to the CRM for {player.full_name}
                  </p>
                </div>

                <div className="grid grid-cols-[1fr,auto,1fr] items-center gap-4">
                  <div className="rounded-xl border bg-card p-5 text-center">
                    <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600">
                      <Gamepad2 className="h-5 w-5" />
                    </div>
                    <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                      {withdrawal.game_name}
                    </div>
                    <div className="mt-1 text-2xl font-bold font-mono tabular-nums">
                      <AnimatedNumber value={gameBalanceDisplay} prefix="RM " />
                    </div>
                  </div>

                  <motion.div
                    initial={{ x: -8, opacity: 0.4 }}
                    animate={{ x: 8, opacity: 1 }}
                    transition={{ repeat: Infinity, repeatType: "reverse", duration: 0.8 }}
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground"
                  >
                    <ArrowDownToLine className="h-5 w-5 rotate-90" />
                  </motion.div>

                  <div className="rounded-xl border border-primary/40 bg-primary/5 p-5 text-center ring-2 ring-primary/10">
                    <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Wallet className="h-5 w-5" />
                    </div>
                    <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                      CRM Wallet
                    </div>
                    <div className="mt-1 text-2xl font-bold font-mono tabular-nums">
                      <AnimatedNumber value={crmBalanceDisplay} prefix="RM " />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Connecting to {withdrawal.game_name} API…
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                className="grid grid-cols-1 sm:grid-cols-[1fr,auto] gap-6 items-center"
              >
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
                      {formatRM(pulled)} pulled from {withdrawal.game_name}
                    </h2>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      Credits are back in the CRM. Proceed to bank payout on the withdrawal row.
                    </p>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button onClick={() => onOpenChange(false)}>
                      Back to Withdrawals
                    </Button>
                  </div>
                </div>

                <div className="flex justify-center sm:justify-end">
                  <TelegramBubble
                    visible={showBubble}
                    playerName={player.full_name}
                    telegramUsername={player.telegram_username}
                    message={`Your withdrawal request for RM ${pulled.toFixed(2)} is being processed. Bank transfer coming shortly.`}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  );
}

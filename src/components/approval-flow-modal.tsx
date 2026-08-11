"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Loader2, Send, XCircle, Bot } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";

type Props = {
  depositId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Minimum time the approving spinner stays on screen. */
const MIN_DISPLAY_MS = 1200;

export function ApprovalFlowModal({ depositId, open, onOpenChange }: Props) {
  const deposit = useStore((s) =>
    depositId ? s.deposits.find((d) => d.deposit_id === depositId) : null,
  );
  const approveDeposit = useStore((s) => s.approveDeposit);
  const player = useStore((s) =>
    deposit?.player_id != null
      ? s.players.find((p) => p.player_id === deposit.player_id)
      : undefined,
  );

  const [phase, setPhase] = useState<"approving" | "success" | "error">(
    "approving",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !depositId) return;
    setPhase("approving");
    setErrorMessage(null);

    let cancelled = false;
    const minDelay = new Promise<void>((resolve) =>
      setTimeout(resolve, MIN_DISPLAY_MS),
    );

    void Promise.all([approveDeposit(depositId), minDelay]).then(([result]) => {
      if (cancelled) return;
      if (result.ok) {
        setPhase("success");
      } else {
        setErrorMessage(result.error ?? "Approval failed. Please try again.");
        setPhase("error");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, depositId, approveDeposit]);

  const playerName = player?.full_name ?? deposit?.player_username ?? "player";

  if (!deposit) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden border-0">
        <DialogTitle className="sr-only">Approve deposit</DialogTitle>

        <div className="relative bg-gradient-to-br from-background via-background to-muted/40">
          <div className="p-8">
            <AnimatePresence mode="wait">
              {phase === "approving" ? (
                <motion.div
                  key="approving"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-center space-y-5"
                >
                  <div className="relative mx-auto h-16 w-16">
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
                      className="absolute inset-0 rounded-full border-4 border-primary/10 border-t-primary"
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Send className="h-7 w-7 text-primary" />
                    </div>
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold">Approving deposit…</h2>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      Handing off to the bot for top-up
                    </p>
                  </div>
                </motion.div>
              ) : phase === "success" ? (
                <motion.div
                  key="success"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: "spring", damping: 18, stiffness: 200 }}
                  className="text-center space-y-4"
                >
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", damping: 10, stiffness: 220, delay: 0.1 }}
                    className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  >
                    <CheckCircle2 className="h-9 w-9" />
                  </motion.div>

                  <div>
                    <h2 className="text-lg font-semibold">Approved &amp; sent to the bot</h2>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      The bot is topping up{" "}
                      <span className="font-semibold text-foreground">
                        {formatRM(deposit.total_amount)}
                      </span>{" "}
                      to{" "}
                      <span className="font-semibold text-foreground">
                        {deposit.selected_game}
                      </span>{" "}
                      for{" "}
                      <span className="font-semibold text-foreground">{playerName}</span>.
                    </p>
                  </div>

                  <div className="mx-auto inline-flex items-center gap-2 rounded-md border bg-blue-500/5 px-3 py-2 text-[12px] text-blue-700 dark:text-blue-300">
                    <Bot className="h-4 w-4" />
                    Now <span className="font-medium">Processing</span> — this row flips to{" "}
                    <span className="font-medium">Completed</span> automatically once the bot confirms.
                  </div>

                  <div className="flex justify-center pt-1">
                    <Button onClick={() => onOpenChange(false)} className="cursor-pointer">
                      Back to Deposits
                    </Button>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="error"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: "spring", damping: 18, stiffness: 200 }}
                  className="text-center space-y-4"
                >
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", damping: 10, stiffness: 220, delay: 0.1 }}
                    className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10 text-red-600 dark:text-red-400"
                  >
                    <XCircle className="h-9 w-9" />
                  </motion.div>

                  <div>
                    <h2 className="text-lg font-semibold">Approval failed</h2>
                    <p className="mt-1.5 text-sm text-muted-foreground">{errorMessage}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Nothing was changed. The deposit is still awaiting approval — you can
                      retry from the deposits list.
                    </p>
                  </div>

                  <div className="flex justify-center pt-1">
                    <Button
                      variant="outline"
                      onClick={() => onOpenChange(false)}
                      className="cursor-pointer"
                    >
                      Close
                    </Button>
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

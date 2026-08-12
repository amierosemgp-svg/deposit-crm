"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SummaryRow = {
  label: string;
  value: React.ReactNode;
  /** Pull the eye to the number that matters — the amount, usually. */
  emphasis?: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One line on what confirming actually does — the consequence, not the verb. */
  description?: string;
  summary: SummaryRow[];
  confirmLabel: string;
  tone?: "default" | "danger";
  onConfirm: () => Promise<unknown> | unknown;
};

/**
 * Confirm before an approve/reject, showing what is being acted on.
 *
 * These actions move money or fail a player's request, and the row you clicked
 * is one of many identical-looking rows — so the dialog restates the subject
 * (who, how much, which account) rather than asking "are you sure?" about
 * nothing in particular. Replaces window.confirm, which could not show any of
 * it and blocks the whole tab.
 */
export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  summary,
  confirmLabel,
  tone = "default",
  onConfirm,
}: Props) {
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Don't let a click-away abandon an action already in flight.
        if (busy) return;
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <dl className="divide-y rounded-md border bg-muted/20 px-3">
          {summary.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between gap-4 py-2 text-sm"
            >
              <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
              <dd
                className={cn(
                  "min-w-0 text-right",
                  row.emphasis ? "font-semibold tabular-nums" : "font-medium",
                )}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        <DialogFooter>
          <Button
            variant="ghost"
            className="cursor-pointer"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            className={cn(
              "cursor-pointer",
              tone === "danger"
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-emerald-600 text-white hover:bg-emerald-700",
            )}
            disabled={busy}
            onClick={() => void handleConfirm()}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

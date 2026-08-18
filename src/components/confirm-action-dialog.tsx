"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
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

/** One selected record, listed so a bulk action names what it will act on. */
export type ConfirmItem = {
  key: string | number;
  /** Who it is — the player, usually. */
  label: React.ReactNode;
  /** The qualifier: game, bank, whatever distinguishes this row from the next. */
  meta?: React.ReactNode;
  /** Right-aligned figure. */
  value?: React.ReactNode;
};

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
  /**
   * The records being acted on, one line each. For a bulk action "3 deposits"
   * is not enough to check against — which three, and for whom, is the thing
   * worth confirming.
   */
  items?: ConfirmItem[];
  /**
   * Drop one record from the selection without leaving the dialog — checking
   * the list is exactly when you notice the one that shouldn't be in it.
   */
  onRemoveItem?: (key: string | number) => void;
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
  items,
  onRemoveItem,
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

        {items && (
          <ul className="max-h-56 divide-y overflow-y-auto rounded-md border">
            {items.length === 0 && (
              <li className="px-3 py-3 text-center text-[12px] text-muted-foreground">
                Nothing selected — close and pick at least one.
              </li>
            )}
            {items.map((item) => (
              <li
                key={item.key}
                className="flex items-center justify-between gap-3 px-3 py-1.5 text-[12px]"
              >
                <span className="min-w-0 truncate font-medium">{item.label}</span>
                {item.meta && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {item.meta}
                  </span>
                )}
                {item.value && (
                  <span className="shrink-0 tabular-nums">{item.value}</span>
                )}
                {onRemoveItem && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRemoveItem(item.key)}
                    aria-label="Remove from this batch"
                    title="Remove from this batch"
                    className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

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
            disabled={busy || (items !== undefined && items.length === 0)}
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

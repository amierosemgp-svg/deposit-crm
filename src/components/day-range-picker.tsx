"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/**
 * A range of days of the month, picked straight on a 1–31 grid. A range may
 * wrap past the month's end (day 28 to day 3). A day past a short month's end
 * (the 31st in April) falls on its last day — the same rule the server applies.
 * The first click picks the start, the second the end. No range at all
 * (null) means every day; "Any day" clears it.
 */
export function DayRangePicker({
  value,
  disabled,
  onChange,
}: {
  value: { from: number; to: number } | null;
  disabled?: boolean;
  onChange: (range: { from: number; to: number } | null) => void;
}) {
  // The start picked while waiting for the end.
  const [pending, setPending] = useState<number | null>(null);

  const start = pending ?? value?.from ?? null;
  const end = pending !== null ? null : (value?.to ?? null);
  const inRange = (d: number) =>
    start === null || end === null ? false : start <= end ? d >= start && d <= end : d >= start || d <= end;

  function pick(d: number) {
    if (pending === null) {
      setPending(d);
    } else {
      onChange({ from: pending, to: d });
      setPending(null);
    }
  }

  const status =
    pending !== null
      ? `From day ${pending} — now pick the last day`
      : !value
        ? "Any day — pick the first pay day, then the last"
        : value.from === value.to
          ? `Day ${value.from} only`
          : `Day ${value.from} – day ${value.to}`;

  return (
    <div className={cn("space-y-2", disabled && "pointer-events-none opacity-50")}>
      <div className="grid grid-cols-7 gap-1">
        {DAYS.map((d) => {
          const isStart = d === start;
          const isEnd = end !== null && d === end && !isStart;
          return (
            <button
              key={d}
              type="button"
              disabled={disabled}
              onClick={() => pick(d)}
              className={cn(
                "h-7 cursor-pointer rounded-md text-xs tabular-nums transition-colors hover:bg-muted",
                inRange(d) && "bg-primary/10",
                isStart && "bg-primary font-medium text-primary-foreground hover:bg-primary/90",
                isEnd && "bg-primary/25 font-medium ring-1 ring-primary ring-inset",
              )}
            >
              {d}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{status}</span>
        {(value || pending !== null) && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setPending(null);
              onChange(null);
            }}
            className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
          >
            Any day
          </button>
        )}
      </div>
    </div>
  );
}

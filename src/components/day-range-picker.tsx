"use client";

import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { CalendarRange, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/**
 * A range of days of the month, picked on a 1–31 grid. A range may wrap past
 * the month's end (day 28 to day 3). A day past a short month's end (the 31st
 * in April) falls on its last day — the same rule the server applies.
 *
 * `fixedEnd` is for a range whose end follows from its start, like the
 * monthly rebate window: one click picks the start. Otherwise the first click
 * picks the start and the second the end.
 */
export function DayRangePicker({
  from,
  to,
  label,
  hint,
  fixedEnd,
  disabled,
  onChange,
}: {
  from: number;
  /** "end" = the month's last day. */
  to: number | "end";
  label: string;
  hint: string;
  fixedEnd?: boolean;
  disabled?: boolean;
  onChange: (range: { from: number; to: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  // The start picked while waiting for the end.
  const [pending, setPending] = useState<number | null>(null);

  const start = pending ?? from;
  const end = pending !== null ? null : to === "end" ? 31 : to;
  const inRange = (d: number) =>
    end === null ? false : start <= end ? d >= start && d <= end : d >= start || d <= end;

  function pick(d: number) {
    if (fixedEnd) {
      onChange({ from: d, to: d });
      setOpen(false);
    } else if (pending === null) {
      setPending(d);
    } else {
      onChange({ from: pending, to: d });
      setPending(null);
      setOpen(false);
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPending(null);
      }}
    >
      <Popover.Trigger
        disabled={disabled}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-left text-sm whitespace-nowrap outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50"
      >
        <CalendarRange className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">{label}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start" className="isolate z-[60]">
          <Popover.Popup className="w-64 rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            <p className="mb-2 text-xs text-muted-foreground">
              {pending !== null ? `From day ${pending} — now pick the last day.` : hint}
            </p>
            <div className="grid grid-cols-7 gap-1">
              {DAYS.map((d) => {
                const isStart = d === start;
                const isEnd = end !== null && d === end && !isStart;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => pick(d)}
                    className={cn(
                      "h-8 cursor-pointer rounded-md text-xs tabular-nums transition-colors hover:bg-muted",
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
            <p className="mt-2 text-xs text-muted-foreground">
              {label}
              {Math.max(start, end ?? 0) > 28 && " (the month's last day in shorter months)"}
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The day a monthly window opening on `day` at `time` closes on. Windows run
 * back to back, so it closes where the next one opens: at midnight that is
 * the end of the day before, any other time the same day next month.
 */
export function monthlyWindow(day: number, time: string): { to: number | "end"; label: string } {
  if (time !== "00:00") return { to: day, label: `Day ${day} ${time} – day ${day} ${time} next month` };
  if (day === 1) return { to: "end", label: "Day 1 – end of month" };
  return { to: day - 1, label: `Day ${day} – day ${day - 1} next month` };
}

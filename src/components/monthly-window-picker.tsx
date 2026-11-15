"use client";

import { Popover } from "@base-ui/react/popover";
import { CalendarRange, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/**
 * The day a monthly window closes on, for one that opens on `day` at `time`.
 * Windows run back to back, so it closes where the next one opens: at
 * midnight that is the end of the day before, any other time the same day
 * next month.
 */
function closingDay(day: number, time: string): number | "end" {
  if (time !== "00:00") return day;
  return day === 1 ? "end" : day - 1;
}

function windowLabel(day: number, time: string): string {
  const end = closingDay(day, time);
  if (end === "end") return "Day 1 – end of month";
  if (time !== "00:00") return `Day ${day} ${time} – day ${end} ${time} next month`;
  return `Day ${day} – day ${end} next month`;
}

/**
 * The monthly rebate window as a range of days. Picking the first day is the
 * whole choice: the last day follows from it, since one month's window ends
 * where the next begins. A day past a short month's end (the 31st in April)
 * falls on its last day — the same rule the server applies.
 */
export function MonthlyWindowPicker({
  day,
  time,
  disabled,
  onChange,
}: {
  day: number;
  time: string;
  disabled?: boolean;
  onChange: (day: number) => void;
}) {
  const end = closingDay(day, time);
  const inRange = (d: number) => (end === "end" ? true : d === day || d === end);

  return (
    <Popover.Root>
      <Popover.Trigger
        disabled={disabled}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-left text-sm whitespace-nowrap outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50"
      >
        <CalendarRange className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">{windowLabel(day, time)}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start" className="isolate z-[60]">
          <Popover.Popup className="w-64 rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            <p className="mb-2 text-xs text-muted-foreground">
              Pick the day each month&apos;s window opens. It closes when the next one opens.
            </p>
            <div className="grid grid-cols-7 gap-1">
              {DAYS.map((d) => {
                const isStart = d === day;
                const isEnd = end !== "end" && d === end && !isStart;
                return (
                  <Popover.Close
                    key={d}
                    onClick={() => onChange(d)}
                    className={cn(
                      "h-8 cursor-pointer rounded-md text-xs tabular-nums transition-colors hover:bg-muted",
                      inRange(d) && "bg-primary/10",
                      isStart && "bg-primary font-medium text-primary-foreground hover:bg-primary/90",
                      isEnd && "ring-1 ring-primary ring-inset",
                    )}
                  >
                    {d}
                  </Popover.Close>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {windowLabel(day, time)}
              {day > 28 && " (the month's last day in shorter months)"}
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

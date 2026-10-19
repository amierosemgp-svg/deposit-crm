"use client";

import { useEffect, useState } from "react";
import { Clock, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatClock } from "@/lib/format";
import { monthLabel } from "./use-staff-pay";

/** A CS's hours for a month, day by day, and the sessions behind them. */
type HoursData = {
  full_name: string;
  worked: { hours: number; days: number; daily: Record<string, number> };
  sessions: Array<{ started_at: string; last_active_at: string }>;
};

export function HoursModal({
  open,
  onOpenChange,
  userId,
  month,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId: number | null;
  month: string;
}) {
  const [data, setData] = useState<HoursData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !userId) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(null);
    setError(null);
    void fetch(`/api/staff-pay/hours?user_id=${userId}&month=${month}`).then(async (res) => {
      const d = (await res.json().catch(() => null)) as (HoursData & { error?: string }) | null;
      if (!live) return;
      if (!res.ok || !d) setError(d?.error ?? "Could not load hours");
      else setData(d);
    });
    return () => {
      live = false;
    };
  }, [open, userId, month]);

  const days = data ? Object.entries(data.worked.daily) : [];
  const sessionsOn = (day: string) =>
    (data?.sessions ?? []).filter(
      (s) =>
        new Date(new Date(s.started_at).getTime() + 8 * 3600_000).toISOString().slice(0, 10) === day,
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          {data?.full_name ?? "Hours"} — {monthLabel(month)}
        </DialogTitle>
        <DialogDescription>
          Signed in and active: sign-in to sign-out, stopping at the last input when the page
          locked after 5 idle minutes.
        </DialogDescription>
        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : !data ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-sm">
              <span className="font-semibold tabular-nums">{data.worked.hours} h</span>
              <span className="text-muted-foreground"> over </span>
              <span className="font-semibold tabular-nums">{data.worked.days} days</span>
            </div>
            <div className="max-h-[50vh] overflow-y-auto rounded-md border">
              {days.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No time on the clock this month.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {days.map(([day, hours]) => (
                      <tr key={day} className="border-b last:border-0">
                        <td className="px-3 py-1.5 tabular-nums">
                          {new Date(`${day}T00:00:00Z`).toLocaleDateString("en-MY", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            timeZone: "UTC",
                          })}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-muted-foreground">
                          {sessionsOn(day)
                            .map((s) => `${formatClock(s.started_at)}–${formatClock(s.last_active_at)}`)
                            .join(", ")}
                        </td>
                        <td className="px-3 py-1.5 text-right font-medium tabular-nums">{hours} h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

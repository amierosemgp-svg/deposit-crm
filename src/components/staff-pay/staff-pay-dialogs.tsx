"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { monthLabel, send, type AttendanceSummary } from "./use-staff-pay";

type DayMark = "notified" | "not_notified";
type DayStatus = "worked" | "off_told" | "off_untold" | "free" | "not_counted";

/** A CS's month, day by day (GET /api/staff-pay/hours). */
type MonthData = {
  full_name: string;
  attendance: AttendanceSummary & {
    days: Array<{ day: string; hours: number; mark: DayMark | null; status: DayStatus; amount: number }>;
  };
  sessions: Array<{ started_at: string; last_active_at: string }>;
};

const STATUS_LABEL: Record<DayStatus, string> = {
  worked: "Worked",
  free: "Off — free",
  off_told: "Off — told",
  off_untold: "Off — not told",
  not_counted: "",
};

const STATUS_TONE: Record<DayStatus, string> = {
  worked: "text-emerald-700 dark:text-emerald-400",
  free: "text-muted-foreground",
  off_told: "text-amber-700 dark:text-amber-400",
  off_untold: "text-red-700 dark:text-red-400",
  not_counted: "text-muted-foreground",
};

const signed = (n: number) => (n === 0 ? "—" : `${n > 0 ? "+" : "−"}${Math.abs(n)}`);

/**
 * A CS's month, day by day: worked or off, what each day off cost, and the
 * leader's marks. There is no schedule — a day with no time on the clock is a
 * day off, and untold unless marked. A leader can also mark a worked day as
 * off: half a day then emergency leave counts as a whole day off.
 */
export function AttendanceModal({
  open,
  onOpenChange,
  userId,
  month,
  canMark,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId: number | null;
  month: string;
  /** Leaders and the admin, on a month not yet paid. */
  canMark: boolean;
  onChanged: () => void;
}) {
  const [data, setData] = useState<MonthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const res = await fetch(`/api/staff-pay/hours?user_id=${userId}&month=${month}`);
    const d = (await res.json().catch(() => null)) as (MonthData & { error?: string }) | null;
    if (!res.ok || !d) setError(d?.error ?? "Could not load the month");
    else setData(d);
  }, [userId, month]);

  useEffect(() => {
    if (!open || !userId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(null);
    setError(null);
    void load();
  }, [open, userId, load]);

  const mark = async (day: string, value: DayMark | null) => {
    if (!userId) return;
    setBusy(day);
    const res = await send("/api/staff-pay/days", "PUT", { user_id: userId, day, mark: value });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    await load();
    onChanged();
  };

  const sessionsOn = (day: string) =>
    (data?.sessions ?? []).filter(
      (s) => new Date(new Date(s.started_at).getTime() + 8 * 3600_000).toISOString().slice(0, 10) === day,
    );

  const a = data?.attendance;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogTitle className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          {data?.full_name ?? "Attendance"} — {monthLabel(month)}
        </DialogTitle>
        <DialogDescription>
          A day with time on the clock is worked; a day without is off, and not told unless marked. 4 days off
          are free, then RM 100 each if told, RM 200 if not.
        </DialogDescription>
        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : !data || !a ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span>
                <b className="tabular-nums">{a.worked}</b> worked
              </span>
              <span>
                <b className="tabular-nums">{a.off}</b> off ({a.off_told} told, {a.off_untold} not told)
              </span>
              <span>
                <b className="tabular-nums">{a.free_used}</b>/4 free used
              </span>
              <span>
                Attendance <b className="tabular-nums">{signed(a.amount)}</b>
                {!a.complete && <span className="text-muted-foreground"> so far</span>}
              </span>
            </div>
            <div className="max-h-[55vh] overflow-y-auto rounded-md border">
              <table className="w-full text-sm">
                <tbody>
                  {a.days.map((d) => {
                    const counted = d.status !== "not_counted";
                    const worked = d.hours > 0;
                    return (
                      <tr key={d.day} className={cn("border-b last:border-0", !counted && "opacity-50")}>
                        <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">
                          {new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-MY", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            timeZone: "UTC",
                          })}
                        </td>
                        <td className="px-2 py-1.5 text-xs text-muted-foreground">
                          {sessionsOn(d.day)
                            .map((s) => `${formatClock(s.started_at)}–${formatClock(s.last_active_at)}`)
                            .join(", ")}
                        </td>
                        <td className={cn("whitespace-nowrap px-2 py-1.5 text-xs font-medium", STATUS_TONE[d.status])}>
                          {STATUS_LABEL[d.status]}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{counted ? signed(d.amount) : ""}</td>
                        <td className="px-2 py-1 text-right">
                          {counted && canMark ? (
                            <select
                              value={d.mark ?? ""}
                              disabled={busy === d.day}
                              onChange={(e) => void mark(d.day, (e.target.value || null) as DayMark | null)}
                              className="h-7 cursor-pointer rounded-md border border-input bg-background px-1.5 text-xs"
                            >
                              {worked ? (
                                <>
                                  <option value="">Worked</option>
                                  <option value="notified">Emergency leave (told)</option>
                                  <option value="not_notified">Left, not told</option>
                                </>
                              ) : (
                                <>
                                  <option value="">Not told</option>
                                  <option value="notified">Told (MC / leave / emergency)</option>
                                </>
                              )}
                            </select>
                          ) : (
                            d.mark && (
                              <span className="text-xs text-muted-foreground">
                                {d.mark === "notified" ? "told" : "not told"}
                              </span>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

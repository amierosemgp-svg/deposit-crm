"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Ban,
  Calendar,
  CalendarDays,
  Clock,
  HandCoins,
  LayoutDashboard,
  Loader2,
  Receipt,
  Send,
  User,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { actionLabel, matchesAction } from "@/lib/shortcut-keys";
import { useStore } from "@/lib/store";
import { formatClock, formatRelative, formatShortDateTime, initialsOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmtAmount } from "./entry-dock";
import {
  ADJUSTMENT_LABEL,
  currentMonth,
  monthLabel,
  PENALTY_SOURCE_LABEL,
  send,
  type AttendanceSummary,
  type SalaryAdjustment,
  type SalaryPayment,
  type StaffPenalty,
} from "./use-staff-pay";

type DayMark = "notified" | "not_notified";
type DayStatus = "worked" | "off_told" | "off_untold" | "free" | "not_counted";
type Day = { day: string; hours: number; mark: DayMark | null; status: DayStatus; amount: number };

/** GET /api/staff-pay/profile. */
type Profile = {
  cs: {
    user_id: number;
    username: string;
    full_name: string;
    status: "active" | "inactive";
    company_entity_id: number;
    telegram_username: string | null;
    last_login_at: string | null;
    first_day: string | null;
  };
  month: string;
  base: number;
  base_set: boolean;
  attendance: AttendanceSummary & { days: Day[] };
  sessions: Array<{ started_at: string; last_active_at: string }>;
  pending_adjustments: number;
  would_pay: number;
  would_carry: number;
  paid_salary_id: number | null;
  payments: SalaryPayment[];
  adjustments: SalaryAdjustment[];
  penalties: StaffPenalty[];
};

const SECTIONS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "attendance", label: "Day by day", icon: CalendarDays },
  { id: "penalties", label: "Penalties", icon: Ban },
  { id: "adjustments", label: "Adjustments & advances", icon: HandCoins },
  { id: "payslips", label: "Payslips", icon: Receipt },
] as const;

export type CsSection = (typeof SECTIONS)[number]["id"];

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

const signed = (n: number) => (n === 0 ? "—" : `${n > 0 ? "+" : "−"}${fmtAmount(Math.abs(n))}`);
const offCell = (a: AttendanceSummary) => (a.off === 0 ? "0" : `${a.off} (${a.off_told} told, ${a.off_untold} not)`);
const dateOf = (iso: string) => new Date(iso).toLocaleDateString("en-MY", { timeZone: "Asia/Kuala_Lumpur" });
const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/**
 * One CS on one screen, the way the player profile shows a player: who they
 * are, the month day by day, and every penalty, adjustment, advance and
 * payslip on record — so whoever records pay or a penalty can check it
 * without leaving the sheet. Opened from a selected row, saved or a NEW
 * ENTRIES row whose CS cell names someone.
 */
export function CsProfileModal({
  open,
  onOpenChange,
  userId,
  initialMonth,
  initialSection,
  canManage,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId: number | null;
  /** The month the sheet is on; defaults to this one. */
  initialMonth?: string;
  initialSection?: CsSection;
  /** Leaders and the admin — they may mark days, on a month not yet paid. */
  canManage: boolean;
  /** A day mark moved the figures; the sheet should reload. */
  onChanged?: () => void;
}) {
  const entityName = useStore((s) => s.entityName);
  const users = useStore((s) => s.users);
  const [month, setMonth] = useState(initialMonth ?? currentMonth());
  const [section, setSection] = useState<CsSection>(initialSection ?? "overview");
  const [data, setData] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyDay, setBusyDay] = useState<string | null>(null);

  // Each opening starts where the caller asked.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMonth(initialMonth ?? currentMonth());
    setSection(initialSection ?? "overview");
  }, [open, userId, initialMonth, initialSection]);

  const load = useCallback(async () => {
    if (!userId) return;
    const res = await fetch(`/api/staff-pay/profile?user_id=${userId}&month=${month}`).catch(() => null);
    const d = (await res?.json().catch(() => null)) as (Profile & { error?: string }) | null;
    if (!res?.ok || !d) setError(d?.error ?? "Could not load this CS");
    else {
      setError(null);
      setData(d);
    }
  }, [userId, month]);

  // A different CS never shows the last one's figures: everything below reads
  // `data` only when it is for this user (and `loaded` only for this month).
  useEffect(() => {
    if (!open || !userId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [open, userId, load]);

  const nameOf = useCallback(
    (id: number | null | undefined) => (id == null ? "" : (users.find((u) => u.user_id === id)?.full_name ?? `#${id}`)),
    [users],
  );

  const mark = async (day: string, value: DayMark | null) => {
    if (!userId) return;
    setBusyDay(day);
    const res = await send("/api/staff-pay/days", "PUT", { user_id: userId, day, mark: value });
    setBusyDay(null);
    if (!res.ok) return void toast.error(res.error);
    await load();
    onChanged?.();
  };

  // Which salary took each adjustment / penalty.
  const payMonth = useMemo(() => new Map((data?.payments ?? []).map((p) => [p.salary_id, p.period_month])), [data]);
  const penaltyStatus = useCallback(
    (p: StaffPenalty) => {
      if (p.status === "void") return { label: "Void", tone: "muted" as const };
      const adj = data?.adjustments.find((a) => a.penalty_id === p.penalty_id && a.salary_id);
      return adj
        ? { label: `Deducted · ${monthLabel(payMonth.get(adj.salary_id!) ?? "")} salary`, tone: "done" as const }
        : { label: "Pending — next salary", tone: "pending" as const };
    },
    [data, payMonth],
  );

  const loaded = data && data.cs.user_id === userId && data.month === month ? data : null;
  const cs = data && data.cs.user_id === userId ? data.cs : null;
  const pending = (data?.adjustments ?? []).filter((a) => a.salary_id === null);
  const counts = {
    penalties: data?.penalties.filter((p) => p.status !== "void").length ?? 0,
    adjustments: data?.adjustments.length ?? 0,
    payslips: data?.payments.length ?? 0,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] w-[95vw] max-w-[1100px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1100px]">
        {error && !cs ? (
          <div className="p-8 text-center text-sm text-red-600 dark:text-red-400">
            <DialogTitle className="sr-only">CS profile</DialogTitle>
            {error}
          </div>
        ) : !cs || !data ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <DialogTitle className="sr-only">CS profile</DialogTitle>
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <DialogHeader className="flex-shrink-0 space-y-0 border-b p-5 pb-4">
              <div className="flex items-start gap-4">
                <Avatar className="h-14 w-14 ring-2 ring-primary/10">
                  <AvatarFallback className="text-base font-semibold">{initialsOf(cs.full_name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <DialogTitle className="flex items-center gap-2 text-lg">
                    {cs.full_name}
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-medium",
                        cs.status === "active"
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {cs.status === "active" ? "Active" : "Inactive"}
                    </span>
                  </DialogTitle>
                  <DialogDescription className="mt-0.5">
                    @{cs.username} · CS · {entityName(cs.company_entity_id)}
                  </DialogDescription>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Send className="h-3 w-3" />
                      {cs.telegram_username ?? "—"}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Calendar className="h-3 w-3" />
                      {cs.first_day ? `First clocked in ${dayLabel(cs.first_day)}` : "Never clocked in"}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="h-3 w-3" />
                      {cs.last_login_at ? `Last login ${formatRelative(cs.last_login_at)}` : "Never logged in"}
                    </span>
                  </div>
                </div>
                <Input
                  type="month"
                  value={month}
                  onChange={(e) => e.target.value && setMonth(e.target.value)}
                  className="mr-6 h-8 w-[150px] text-[13px]"
                  title="The month the attendance and Would pay are for"
                />
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Base salary" value={data.base_set ? fmtAmount(data.base) : "Not set"} warn={!data.base_set} />
                <Stat
                  label={`${monthLabel(month)} — worked / off`}
                  value={loaded ? `${loaded.attendance.worked} / ${loaded.attendance.off}` : "…"}
                  sub={loaded ? `${loaded.attendance.free_used}/4 free used` : undefined}
                />
                <Stat
                  label="Attendance"
                  value={loaded ? signed(loaded.attendance.amount) : "…"}
                  sub={loaded && !loaded.attendance.complete ? "so far" : undefined}
                  tone={loaded ? Math.sign(loaded.attendance.amount) : 0}
                />
                <Stat
                  label={loaded?.paid_salary_id ? `${monthLabel(month)} salary` : "Would pay"}
                  value={
                    !loaded
                      ? "…"
                      : loaded.paid_salary_id
                        ? "Paid"
                        : loaded.would_carry > 0
                          ? "0.00"
                          : fmtAmount(loaded.would_pay)
                  }
                  sub={
                    loaded && !loaded.paid_salary_id && loaded.would_carry > 0
                      ? `advance −${fmtAmount(loaded.would_carry)} carries`
                      : loaded && !loaded.paid_salary_id && loaded.pending_adjustments !== 0
                        ? `adjustments ${signed(loaded.pending_adjustments)}`
                        : undefined
                  }
                />
              </div>
            </DialogHeader>

            <div className="flex flex-1 overflow-hidden">
              <nav className="w-52 flex-shrink-0 space-y-0.5 overflow-y-auto border-r bg-muted/30 p-2">
                {SECTIONS.map((s) => {
                  const Icon = s.icon;
                  const active = section === s.id;
                  const count = s.id in counts ? counts[s.id as keyof typeof counts] : null;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSection(s.id)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                        active
                          ? "bg-primary font-medium text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{s.label}</span>
                      {count ? <span className="ml-auto text-[11px] tabular-nums opacity-70">{count}</span> : null}
                    </button>
                  );
                })}
              </nav>

              <div className="flex-1 overflow-y-auto p-5">
                {section === "overview" && (
                  <div className="space-y-6">
                    <section>
                      <SectionTitle>Waiting on the next salary</SectionTitle>
                      {pending.length === 0 ? (
                        <Empty>Nothing pending — no bonus, deduction, advance or penalty waiting.</Empty>
                      ) : (
                        <Table head={["Date", "Type", "Reason", "Amount"]} right={[3]}>
                          {pending.map((a) => (
                            <tr key={a.adjustment_id} className="border-b last:border-0">
                              <Td>{dateOf(a.occurred_at)}</Td>
                              <Td>{ADJUSTMENT_LABEL[a.kind]}</Td>
                              <Td className="whitespace-normal">{a.reason}</Td>
                              <Td right tone={Math.sign(a.amount)}>
                                {signed(a.amount)}
                              </Td>
                            </tr>
                          ))}
                          <tr className="bg-muted/40 font-medium">
                            <Td colSpan={3}>Total</Td>
                            <Td right tone={Math.sign(data.pending_adjustments)}>
                              {signed(data.pending_adjustments)}
                            </Td>
                          </tr>
                        </Table>
                      )}
                    </section>
                    {loaded && (
                      <section>
                        <SectionTitle>{monthLabel(month)} attendance</SectionTitle>
                        <AttendanceLine a={loaded.attendance} />
                        <button
                          type="button"
                          onClick={() => setSection("attendance")}
                          className="mt-1 cursor-pointer text-xs font-medium text-primary hover:underline"
                        >
                          See it day by day →
                        </button>
                      </section>
                    )}
                    <section>
                      <SectionTitle>Recent payslips</SectionTitle>
                      <Payslips rows={data.payments.slice(0, 3)} />
                    </section>
                  </div>
                )}

                {section === "attendance" &&
                  (!loaded ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        A day with time on the clock is worked; a day without is off, and not told unless marked. 4
                        days off are free, then RM 100 each if told, RM 200 if not.
                      </p>
                      <AttendanceLine a={loaded.attendance} />
                      <AttendanceDays
                        data={loaded}
                        canMark={canManage && !loaded.paid_salary_id}
                        busyDay={busyDay}
                        onMark={mark}
                      />
                    </div>
                  ))}

                {section === "penalties" &&
                  (data.penalties.length === 0 ? (
                    <Empty>No penalties on record.</Empty>
                  ) : (
                    <Table
                      head={["Date", "Mistake on", "Ref", "Credited", "Retrieved", "Lost", "Share", "Penalty", "What happened", "Status"]}
                      right={[3, 4, 5, 6, 7]}
                    >
                      {data.penalties.map((p) => {
                        const st = penaltyStatus(p);
                        return (
                          <tr key={p.penalty_id} className={cn("border-b last:border-0", st.tone === "muted" && "opacity-50")}>
                            <Td>{dateOf(p.occurred_at)}</Td>
                            <Td>{PENALTY_SOURCE_LABEL[p.source_type]}</Td>
                            <Td>{p.source_id ? `#${p.source_id}` : ""}</Td>
                            <Td right>{fmtAmount(p.credit_injected)}</Td>
                            <Td right>{fmtAmount(p.credit_retrieved)}</Td>
                            <Td right>{fmtAmount(p.loss_amount)}</Td>
                            <Td right>{p.share_pct}%</Td>
                            <Td right tone={-1}>
                              {fmtAmount(p.amount)}
                            </Td>
                            <Td className="min-w-[200px] whitespace-normal" title={`Recorded by ${nameOf(p.recorded_by_user_id)}`}>
                              {p.reason}
                            </Td>
                            <Td className={cn(st.tone === "pending" && "text-amber-700 dark:text-amber-400")}>{st.label}</Td>
                          </tr>
                        );
                      })}
                    </Table>
                  ))}

                {section === "adjustments" &&
                  (data.adjustments.length === 0 ? (
                    <Empty>No bonuses, deductions or advances on record.</Empty>
                  ) : (
                    <Table head={["Date", "Type", "Reason", "Amount", "Status", "By"]} right={[3]}>
                      {data.adjustments.map((a) => (
                        <tr key={a.adjustment_id} className="border-b last:border-0">
                          <Td>{dateOf(a.occurred_at)}</Td>
                          <Td>{ADJUSTMENT_LABEL[a.kind]}</Td>
                          <Td className="min-w-[220px] whitespace-normal">{a.reason}</Td>
                          <Td right tone={Math.sign(a.amount)}>
                            {signed(a.amount)}
                          </Td>
                          <Td className={cn(!a.salary_id && "text-amber-700 dark:text-amber-400")}>
                            {a.salary_id ? `In ${monthLabel(payMonth.get(a.salary_id) ?? "")} salary` : "Pending — next salary"}
                          </Td>
                          <Td>{nameOf(a.created_by_user_id)}</Td>
                        </tr>
                      ))}
                    </Table>
                  ))}

                {section === "payslips" && <Payslips rows={data.payments} paidBy={nameOf} />}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, sub, warn, tone = 0 }: { label: string; value: string; sub?: string; warn?: boolean; tone?: number }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-lg font-semibold tabular-nums",
          warn && "text-amber-700 dark:text-amber-400",
          tone > 0 && "text-emerald-600 dark:text-emerald-400",
          tone < 0 && "text-rose-600 dark:text-rose-400",
        )}
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function Table({ head, right = [], children }: { head: string[]; right?: number[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={cn("whitespace-nowrap px-3 py-1.5 font-medium", right.includes(i) ? "text-right" : "text-left")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({
  children,
  right,
  tone = 0,
  className,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & { right?: boolean; tone?: number }) {
  return (
    <td
      {...rest}
      className={cn(
        "whitespace-nowrap px-3 py-1.5 align-top",
        right && "text-right tabular-nums",
        tone > 0 && "text-emerald-700 dark:text-emerald-400",
        tone < 0 && "text-rose-700 dark:text-rose-400",
        className,
      )}
    >
      {children}
    </td>
  );
}

function AttendanceLine({ a }: { a: AttendanceSummary }) {
  return (
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
      {(a.charged_told > 0 || a.charged_untold > 0) && (
        <span>
          charged <b className="tabular-nums">{a.charged_told}</b> told, <b className="tabular-nums">{a.charged_untold}</b> not told
        </span>
      )}
      <span>
        Attendance <b className="tabular-nums">{signed(a.amount)}</b>
        {!a.complete && <span className="text-muted-foreground"> so far</span>}
      </span>
    </div>
  );
}

/**
 * The month day by day: worked or off, what each day off cost, and the
 * leader's marks. A leader can also mark a worked day as off: half a day then
 * emergency leave counts as a whole day off.
 */
function AttendanceDays({
  data,
  canMark,
  busyDay,
  onMark,
}: {
  data: Pick<Profile, "attendance" | "sessions">;
  canMark: boolean;
  busyDay: string | null;
  onMark: (day: string, mark: DayMark | null) => void;
}) {
  const sessionsOn = (day: string) =>
    data.sessions.filter((s) => new Date(new Date(s.started_at).getTime() + 8 * 3600_000).toISOString().slice(0, 10) === day);

  return (
    <div className="rounded-md border">
      <table className="w-full text-sm">
        <tbody>
          {data.attendance.days.map((d) => {
            const counted = d.status !== "not_counted";
            const worked = d.hours > 0;
            return (
              <tr key={d.day} className={cn("border-b last:border-0", !counted && "opacity-50")}>
                <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{dayLabel(d.day)}</td>
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
                      disabled={busyDay === d.day}
                      onChange={(e) => onMark(d.day, (e.target.value || null) as DayMark | null)}
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
                    d.mark && <span className="text-xs text-muted-foreground">{d.mark === "notified" ? "told" : "not told"}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Payslips({ rows, paidBy }: { rows: SalaryPayment[]; paidBy?: (id: number) => string }) {
  if (!rows.length) return <Empty>No salary paid yet.</Empty>;
  return (
    <Table
      head={["Month", "Worked", "Days off", "Base", "Attendance", "Adjustments", "Pay", "Carried", "Status", "Paid at", ...(paidBy ? ["By"] : [])]}
      right={[1, 3, 4, 5, 6, 7]}
    >
      {rows.map((p) => (
        <tr key={p.salary_id} className={cn("border-b last:border-0", p.status === "reversed" && "opacity-50")}>
          <Td>{monthLabel(p.period_month)}</Td>
          <Td right>{p.attendance?.worked ?? p.days_worked}</Td>
          <Td>{p.attendance ? offCell(p.attendance) : p.tier_name ? `— (tier: ${p.tier_name})` : "—"}</Td>
          <Td right>{fmtAmount(p.base_amount)}</Td>
          <Td right>{p.attendance ? signed(p.attendance_amount) : "—"}</Td>
          <Td right>{signed(p.adjustments_total)}</Td>
          <Td right className="font-medium">
            {fmtAmount(p.net_amount)}
          </Td>
          <Td right>{p.carried_forward ? fmtAmount(p.carried_forward) : "—"}</Td>
          <Td>{p.status === "reversed" ? "Reversed" : "Paid"}</Td>
          <Td>{formatShortDateTime(p.paid_at)}</Td>
          {paidBy && <Td>{paidBy(p.recorded_by_user_id)}</Td>}
        </tr>
      ))}
    </Table>
  );
}

/**
 * "CS" on the selection bar, with the key the player profile uses (⌘L), so
 * the same reflex opens a CS from the staff-pay sheets.
 */
export function CsProfileButton({ onClick }: { onClick: () => void }) {
  const k = actionLabel("viewPlayer");
  return (
    <Button size="xs" variant="outline" onClick={onClick} title="Open the CS's profile" className="cursor-pointer gap-1">
      <User className="h-3 w-3" />
      CS profile
      {k && (
        <kbd className="ml-0.5 rounded border border-border bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
          {k}
        </kbd>
      )}
    </Button>
  );
}

/** ⌘L opens the CS behind the selection — not while a cell is being typed in. */
export function useCsProfileShortcut(userId: number | null, open: (id: number) => void) {
  useEffect(() => {
    if (!userId) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!matchesAction(e, "viewPlayer")) return;
      e.preventDefault();
      e.stopPropagation();
      open(userId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [userId, open]);
}

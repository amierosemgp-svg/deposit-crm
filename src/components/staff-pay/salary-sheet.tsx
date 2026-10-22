"use client";

/**
 * The Salary worksheet tab, three views:
 *
 *   Payslips     — salaries paid; the NEW ENTRIES dock pays the next ones.
 *                  Type the month and the CS, and the days, base, attendance,
 *                  pay and pending adjustments fill themselves; pick what it's
 *                  paid from and ⌘S. Nothing about the amount is typed.
 *   Staff & attendance — each CS's month so far: base, days worked and off
 *                  (told / not told, free / charged), what it would pay.
 *   Adjustments  — bonuses, deductions, advances, penalties and carries
 *                  waiting on (or taken by) a salary; the dock adds bonuses,
 *                  deductions and advances.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, Loader2, RefreshCw, Save, Trash2, Undo2, Wallet, X } from "lucide-react";
import { SheetGrid, type SheetColumn, type SheetRow } from "@/components/sheet/sheet-grid";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";
import { formatRM, formatShortDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AttendanceModal } from "./staff-pay-dialogs";
import { BaseSalaryModal } from "./base-salary-modal";
import {
  fmtAmount,
  parseAmount,
  parseMonth,
  parseSheetDate,
  todaySheetDate,
  useEntryDock,
  type Parsed,
} from "./entry-dock";
import {
  ADJUSTMENT_LABEL,
  currentMonth,
  monthLabel,
  send,
  useStaffPay,
  type AdjustmentKind,
  type AttendanceSummary,
  type SalaryAdjustment,
  type SalaryPayment,
  type StaffRow,
} from "./use-staff-pay";

type View = "payslips" | "staff" | "adjustments";

const VIEWS: Array<[View, string]> = [
  ["payslips", "Payslips"],
  ["staff", "Staff & attendance"],
  ["adjustments", "Adjustments"],
];

const signed = (n: number) => (n === 0 ? "—" : `${n > 0 ? "+" : "−"}${fmtAmount(Math.abs(n))}`);
const noop = () => {};
const noDraftStatus = () => ({ state: "empty" as const });
const MOD_LABEL = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

// Payslip columns, saved rows and the dock alike.
const P = { month: 0, cs: 1, casino: 2, worked: 3, off: 4, base: 5, att: 6, adj: 7, net: 8, carry: 9, from: 10, status: 11, at: 12, by: 13, notes: 14 } as const;
const P_COLS = 15;
// Adjustment columns.
const A = { date: 0, cs: 1, kind: 2, reason: 3, amount: 4, status: 5, by: 6 } as const;
const A_COLS = 7;

type Preview = {
  company_entity_id: number;
  base: number;
  attendance: AttendanceSummary;
  adjustments_total: number;
  net: number;
  carried: number;
};

/** "6 (2 told, 4 not)" — days off, and how many were told. */
const offCell = (a: AttendanceSummary) => (a.off === 0 ? "0" : `${a.off} (${a.off_told} told, ${a.off_untold} not)`);
type PreviewEntry = { preview: Preview } | { error: string };

/** The month before this one — the one usually being paid. */
function lastMonth(): string {
  const [y, m] = currentMonth().split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function SalarySheet() {
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const bankAccounts = useStore((s) => s.bankAccounts);
  const entities = useStore((s) => s.entities);
  const entityName = useStore((s) => s.entityName);
  const companyInScope = useStore((s) => s.companyInScope);
  const refreshStore = useStore((s) => s.refresh);
  const isViewer = me?.role === "viewer";
  const isAdmin = me?.role === "super_admin";
  const canManage = isAdmin || me?.role === "company_leader";

  const [month, setMonth] = useState(currentMonth);
  const [view, setView] = useState<View>("payslips");
  const { data, loading, error, reload } = useStaffPay(month);
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [search, setSearch] = useState("");
  const [daysFor, setDaysFor] = useState<number | null>(null);
  const [basesOpen, setBasesOpen] = useState(false);
  const [confirming, setConfirming] = useState<
    { kind: "reverse"; salary: SalaryPayment } | { kind: "remove"; adj: SalaryAdjustment } | null
  >(null);

  const switchView = (v: View) => {
    setView(v);
    setSelectedIds([]);
  };

  const staff = useMemo(
    () => (data?.staff ?? []).filter((s) => companyInScope(s.company_entity_id)),
    [data, companyInScope],
  );
  const nameOf = useCallback(
    (id: number | null | undefined) =>
      id == null
        ? ""
        : (data?.staff.find((s) => s.user_id === id)?.full_name ??
          users.find((u) => u.user_id === id)?.full_name ??
          `#${id}`),
    [data, users],
  );

  // ---- lookups the dock types against ----

  const csOptions = useMemo(
    () =>
      staff
        .filter((s) => s.status === "active")
        .sort((a, b) => a.full_name.localeCompare(b.full_name))
        .map((s) => ({ value: s.full_name, hint: `${s.username} · ${entityName(s.company_entity_id)}` })),
    [staff, entityName],
  );
  /** A CS cell, by full name or username. */
  const resolveCs = useCallback(
    (cell: string): StaffRow | null => {
      const v = cell.trim().toLowerCase();
      if (!v) return null;
      const active = staff.filter((s) => s.status === "active");
      return (
        active.find((s) => s.full_name.toLowerCase() === v) ??
        active.find((s) => s.username.toLowerCase() === v) ??
        null
      );
    },
    [staff],
  );

  /** The casino's own accounts first, then a leader's cash (admin only). */
  const payFrom = useMemo(() => {
    const accounts = bankAccounts
      .filter((a) => a.status === "active")
      .map((a) => ({
        cell: `${a.label?.trim() ? `${a.label.trim()} · ` : ""}${a.bank_name} ${a.account_number}`,
        hint: `${entityName(a.entity_id)} · ${formatRM(a.current_balance)}`,
        account_id: a.account_id as number | null,
        cash_entity_id: null as number | null,
        entity_id: a.entity_id,
      }));
    const cash = isAdmin
      ? entities
          .filter((e) => e.entity_type === "leader" && e.status === "active")
          .map((e) => ({
            cell: `Cash · ${e.name}`,
            hint: "leader's own cash",
            account_id: null as number | null,
            cash_entity_id: e.entity_id as number | null,
            entity_id: e.entity_id,
          }))
      : [];
    return [...accounts, ...cash];
  }, [bankAccounts, entities, entityName, isAdmin]);
  const resolvePayFrom = useCallback(
    (cell: string) => payFrom.find((p) => p.cell.toLowerCase() === cell.trim().toLowerCase()) ?? null,
    [payFrom],
  );

  // ---- salary previews for the dock: one per (CS, month) typed ----

  const [previews, setPreviews] = useState<Map<string, PreviewEntry>>(new Map());
  const previewKey = (userId: number, m: string) => `${userId}:${m}`;

  // ---- Payslips dock ----

  const payAutoCells = useCallback((): Array<[number, string]> => [[P.month, monthLabel(lastMonth())]], []);

  const alreadyPaid = useCallback(
    (userId: number, m: string) =>
      (data?.payments ?? []).some((p) => p.user_id === userId && p.period_month === m && p.status === "paid"),
    [data],
  );

  const payDerive = useCallback(
    (rows: string[][]) =>
      rows.map((row) => {
        const next = [...row];
        for (const c of [P.casino, P.worked, P.off, P.base, P.att, P.adj, P.net, P.carry, P.status, P.at, P.by]) next[c] = "";
        const cs = resolveCs(row[P.cs] ?? "");
        const m = parseMonth(row[P.month] ?? "");
        if (!cs || !m) return next;
        next[P.casino] = entityName(cs.company_entity_id);
        if (alreadyPaid(cs.user_id, m)) {
          next[P.status] = "Already paid";
          return next;
        }
        const entry = previews.get(previewKey(cs.user_id, m));
        if (!entry) {
          next[P.status] = "Working out…";
          return next;
        }
        if ("error" in entry) {
          next[P.status] = entry.error;
          return next;
        }
        const p = entry.preview;
        next[P.worked] = String(p.attendance.worked);
        next[P.off] = offCell(p.attendance);
        next[P.base] = fmtAmount(p.base);
        next[P.att] = signed(p.attendance.amount);
        next[P.adj] = signed(p.adjustments_total);
        next[P.net] = fmtAmount(p.net);
        next[P.carry] = p.carried ? fmtAmount(p.carried) : "—";
        next[P.status] = !p.attendance.complete ? "Month not over yet" : p.base === 0 ? "No base salary set" : "To pay";
        return next;
      }),
    [resolveCs, entityName, alreadyPaid, previews],
  );

  type PayBody = {
    user_id: number;
    month: string;
    paid_from_account_id: number | null;
    paid_from_cash_entity_id: number | null;
    expected_net: number;
    notes?: string;
  };
  const payParse = useCallback(
    (row: string[]): Parsed<PayBody> | null => {
      const m = parseMonth(row[P.month] ?? "");
      if (!m) return { ok: false, error: `Month: type it like "Sep 2026" or 2026-09` };
      if (!(row[P.cs] ?? "").trim()) return { ok: false, error: "Who — pick the CS" };
      const cs = resolveCs(row[P.cs]);
      if (!cs) return { ok: false, error: `No CS called "${row[P.cs].trim()}" — pick from the list` };
      if (alreadyPaid(cs.user_id, m)) return { ok: false, error: `${monthLabel(m)} is already paid — reverse it first` };
      const entry = previews.get(previewKey(cs.user_id, m));
      if (!entry) return null;
      if ("error" in entry) return { ok: false, error: entry.error };
      const p = entry.preview;
      if (!p.attendance.complete) return { ok: false, error: `${monthLabel(m)} isn't over yet — pay it next month, or record an advance` };
      const fromCell = (row[P.from] ?? "").trim();
      const from = fromCell ? resolvePayFrom(fromCell) : null;
      if (p.net > 0 && !fromCell) return { ok: false, error: "Paid From — the account (or leader's cash) it comes out of" };
      if (fromCell && !from) return { ok: false, error: `Paid From "${fromCell}" isn't one of the accounts — pick from the list` };
      return {
        ok: true,
        body: {
          user_id: cs.user_id,
          month: m,
          paid_from_account_id: p.net > 0 ? (from?.account_id ?? null) : null,
          paid_from_cash_entity_id: p.net > 0 ? (from?.cash_entity_id ?? null) : null,
          expected_net: p.net,
          notes: (row[P.notes] ?? "").trim() || undefined,
        },
      };
    },
    [resolveCs, alreadyPaid, previews, resolvePayFrom],
  );

  const afterSave = useCallback(async () => {
    setPreviews(new Map());
    await Promise.all([reload(), refreshStore()]);
  }, [reload, refreshStore]);

  const payDock = useEntryDock<PayBody>({
    nCols: P_COLS,
    autoCells: payAutoCells,
    derive: payDerive,
    parse: payParse,
    submit: async (body) => {
      const res = await send("/api/salaries", "POST", body);
      if (!res.ok) {
        // The figure may have moved — work it out again.
        setPreviews((prev) => {
          const next = new Map(prev);
          next.delete(previewKey(body.user_id, body.month));
          return next;
        });
      }
      return res.ok ? { ok: true } : res;
    },
    noun: (n) => (n === 1 ? "salary" : "salaries"),
    onSaved: afterSave,
    enabled: view === "payslips" && canManage,
  });

  // Fetch a preview for every (CS, month) the dock names that we don't have.
  const payDrafts = payDock.drafts;
  useEffect(() => {
    if (view !== "payslips") return;
    const wanted = new Map<string, { userId: number; month: string }>();
    for (const row of payDrafts) {
      const cs = resolveCs(row[P.cs] ?? "");
      const m = parseMonth(row[P.month] ?? "");
      if (cs && m && !alreadyPaid(cs.user_id, m) && !previews.has(previewKey(cs.user_id, m))) {
        wanted.set(previewKey(cs.user_id, m), { userId: cs.user_id, month: m });
      }
    }
    if (!wanted.size) return;
    let live = true;
    void Promise.all(
      [...wanted.entries()].map(async ([key, w]): Promise<[string, PreviewEntry]> => {
        try {
          const res = await fetch(`/api/salaries/preview?user_id=${w.userId}&month=${w.month}`);
          const d = (await res.json().catch(() => null)) as { preview?: Preview; error?: string } | null;
          return [key, res.ok && d?.preview ? { preview: d.preview } : { error: d?.error ?? "Could not work it out" }];
        } catch {
          return [key, { error: "Network error" }];
        }
      }),
    ).then((entries) => {
      if (!live) return;
      setPreviews((prev) => {
        const next = new Map(prev);
        for (const [k, v] of entries) next.set(k, v);
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [view, payDrafts, resolveCs, alreadyPaid, previews]);

  // ---- Adjustments dock ----

  const adjAutoCells = useCallback(
    (): Array<[number, string]> => [
      [A.date, todaySheetDate()],
      [A.kind, "Bonus"],
    ],
    [],
  );
  const adjDerive = useCallback(
    (rows: string[][]) =>
      rows.map((row) => {
        const next = [...row];
        next[A.status] = resolveCs(row[A.cs] ?? "") ? "Pending — next salary" : "";
        next[A.by] = "";
        return next;
      }),
    [resolveCs],
  );
  type AdjBody = { user_id: number; kind: "bonus" | "deduction" | "advance"; amount: number; reason: string; occurred_at: string };
  const adjParse = useCallback(
    (row: string[]): Parsed<AdjBody> => {
      const date = parseSheetDate(row[A.date] ?? "");
      if (!date) return { ok: false, error: `Bad date "${(row[A.date] ?? "").trim()}" (use 31/8/2026)` };
      const cs = resolveCs(row[A.cs] ?? "");
      if (!cs) return { ok: false, error: (row[A.cs] ?? "").trim() ? `No CS called "${row[A.cs].trim()}"` : "Who — pick the CS" };
      const k = (row[A.kind] ?? "").trim().toLowerCase();
      const kind =
        k.startsWith("b") || k === "+" ? "bonus" : k.startsWith("d") || k === "-" ? "deduction" : k.startsWith("a") ? "advance" : null;
      if (!kind) return { ok: false, error: `Type is Bonus, Deduction or Advance, not "${row[A.kind].trim()}"` };
      const amount = parseAmount(row[A.amount] ?? "");
      if (amount === null || amount <= 0) return { ok: false, error: "Amount — a figure above 0" };
      const reason = (row[A.reason] ?? "").trim();
      if (!reason) return { ok: false, error: "Reason — what it's for" };
      return { ok: true, body: { user_id: cs.user_id, kind, amount, reason, occurred_at: `${date}T12:00:00+08:00` } };
    },
    [resolveCs],
  );
  const adjDock = useEntryDock<AdjBody>({
    nCols: A_COLS,
    autoCells: adjAutoCells,
    derive: adjDerive,
    parse: adjParse,
    submit: async (body) => {
      const res = await send("/api/salary-adjustments", "POST", body);
      return res.ok ? { ok: true } : res;
    },
    noun: (n) => (n === 1 ? "adjustment" : "adjustments"),
    onSaved: afterSave,
    enabled: view === "adjustments" && canManage,
  });

  // ---- what the sheet shows ----

  const paidFromCell = useCallback(
    (p: SalaryPayment) => {
      if (p.paid_from_account_id) {
        const a = bankAccounts.find((x) => x.account_id === p.paid_from_account_id);
        return a ? `${a.label?.trim() ? `${a.label.trim()} · ` : ""}${a.bank_name} ${a.account_number}` : `Account #${p.paid_from_account_id}`;
      }
      if (p.paid_from_cash_entity_id) return `Cash · ${entityName(p.paid_from_cash_entity_id)}`;
      return "—";
    },
    [bankAccounts, entityName],
  );

  const q = search.trim().toLowerCase();
  const hit = useCallback((cells: string[]) => !q || cells.some((c) => c.toLowerCase().includes(q)), [q]);

  const { columns, rows } = useMemo((): { columns: SheetColumn[]; rows: SheetRow[] } => {
    if (view === "payslips") {
      const columns: SheetColumn[] = [
        { key: "month", label: "Month", width: 92, entry: true, required: true, placeholder: monthLabel(lastMonth()) },
        { key: "cs", label: "CS", width: 170, entry: true, required: true, options: csOptions, placeholder: "who" },
        { key: "casino", label: "Casino", width: 120 },
        { key: "worked", label: "Worked", width: 66, align: "right", numeric: true },
        { key: "off", label: "Days Off", width: 140 },
        { key: "base", label: "Base", width: 92, align: "right", numeric: true },
        { key: "att", label: "Attendance", width: 92, align: "right", numeric: true },
        { key: "adj", label: "Adjustments", width: 98, align: "right", numeric: true },
        { key: "net", label: "Pay", width: 96, align: "right", numeric: true },
        { key: "carry", label: "Carried", width: 80, align: "right", numeric: true },
        {
          key: "from",
          label: "Paid From",
          width: 200,
          entry: true,
          options: payFrom.map((p) => ({ value: p.cell, hint: p.hint })),
          placeholder: "bank account / leader cash",
        },
        { key: "status", label: "Status", width: 150 },
        { key: "at", label: "Paid At", width: 120 },
        { key: "by", label: "By", width: 100 },
        { key: "notes", label: "Notes", width: 200, entry: true, placeholder: "optional" },
      ];
      const rows = (data?.payments ?? [])
        .filter((p) => companyInScope(p.company_entity_id))
        .slice()
        .sort((a, b) => a.paid_at.localeCompare(b.paid_at))
        .map((p): SheetRow => {
          const cells = Array<string>(P_COLS).fill("");
          cells[P.month] = monthLabel(p.period_month);
          cells[P.cs] = nameOf(p.user_id);
          cells[P.casino] = entityName(p.company_entity_id);
          // Salaries paid under the old tier ladder have no attendance.
          cells[P.worked] = String(p.attendance?.worked ?? p.days_worked);
          cells[P.off] = p.attendance ? offCell(p.attendance) : p.tier_name ? `— (tier: ${p.tier_name})` : "—";
          cells[P.base] = fmtAmount(p.base_amount);
          cells[P.att] = p.attendance ? signed(p.attendance_amount) : "—";
          cells[P.adj] = signed(p.adjustments_total);
          cells[P.net] = fmtAmount(p.net_amount);
          cells[P.carry] = p.carried_forward ? fmtAmount(p.carried_forward) : "—";
          cells[P.from] = p.net_amount === 0 ? "—" : paidFromCell(p);
          cells[P.status] = p.status === "reversed" ? "Reversed" : "Paid";
          cells[P.at] = formatShortDateTime(p.paid_at);
          cells[P.by] = nameOf(p.recorded_by_user_id);
          cells[P.notes] = p.notes ?? "";
          return { id: p.salary_id, tone: p.status === "reversed" ? "muted" : "success", cells };
        })
        .filter((r) => hit(r.cells));
      return { columns, rows };
    }

    if (view === "staff") {
      const columns: SheetColumn[] = [
        { key: "cs", label: "CS", width: 170 },
        { key: "casino", label: "Casino", width: 120 },
        { key: "base", label: "Base", width: 90, align: "right", numeric: true },
        { key: "worked", label: "Worked", width: 70, align: "right", numeric: true },
        { key: "off", label: "Days Off", width: 150 },
        { key: "free", label: "Free Used", width: 80, align: "right", numeric: true },
        { key: "charged", label: "Charged", width: 130 },
        { key: "att", label: "Attendance", width: 96, align: "right", numeric: true },
        { key: "pending", label: "Pending Adj.", width: 104, align: "right", numeric: true },
        { key: "net", label: "Would Pay", width: 150, align: "right", numeric: true },
        { key: "status", label: monthLabel(month), width: 100, align: "center" },
      ];
      const rows = staff
        .slice()
        .sort((a, b) => a.full_name.localeCompare(b.full_name))
        .map((s): SheetRow => {
          const a = s.attendance;
          const charged = [a.charged_told && `${a.charged_told} told`, a.charged_untold && `${a.charged_untold} not told`]
            .filter(Boolean)
            .join(", ");
          return {
            id: s.user_id,
            tone: s.paid_salary_id ? "success" : s.status === "inactive" ? "muted" : a.charged_untold ? "warning" : "default",
            cells: [
              s.full_name + (s.status === "inactive" ? " (inactive)" : ""),
              entityName(s.company_entity_id),
              s.base_set ? fmtAmount(s.base) : "Not set",
              String(a.worked),
              offCell(a),
              `${a.free_used}/4`,
              charged || "—",
              signed(a.amount) + (a.complete || a.amount === 0 ? "" : " so far"),
              signed(s.pending_adjustments),
              s.paid_salary_id
                ? ""
                : s.would_carry > 0
                  ? `0.00 (advance −${fmtAmount(s.would_carry)} carries)`
                  : fmtAmount(s.would_pay),
              s.paid_salary_id ? "Paid" : "Not paid",
            ],
          };
        })
        .filter((r) => hit(r.cells));
      return { columns, rows };
    }

    const payMonth = new Map((data?.payments ?? []).map((p) => [p.salary_id, p.period_month]));
    const columns: SheetColumn[] = [
      { key: "date", label: "Date", width: 92, align: "center", entry: true, required: true, placeholder: todaySheetDate() },
      { key: "cs", label: "CS", width: 170, entry: true, required: true, options: csOptions, placeholder: "who" },
      { key: "kind", label: "Type", width: 120, entry: true, required: true, options: ["Bonus", "Deduction", "Advance"] },
      { key: "reason", label: "Reason", width: 280, entry: true, required: true, placeholder: "what it's for" },
      { key: "amount", label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "100" },
      { key: "status", label: "Status", width: 170 },
      { key: "by", label: "By", width: 110 },
    ];
    const rows = (data?.adjustments ?? [])
      .filter((a) => companyInScope(a.company_entity_id))
      .slice()
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
      .map((a): SheetRow => ({
        id: a.adjustment_id,
        tone: a.salary_id ? "muted" : a.amount > 0 ? "success" : "warning",
        cells: [
          new Date(a.occurred_at).toLocaleDateString("en-MY", { timeZone: "Asia/Kuala_Lumpur" }),
          nameOf(a.user_id),
          ADJUSTMENT_LABEL[a.kind as AdjustmentKind],
          a.reason,
          signed(a.amount),
          a.salary_id ? `In ${monthLabel(payMonth.get(a.salary_id) ?? "")} salary` : "Pending — next salary",
          nameOf(a.created_by_user_id),
        ],
      }))
      .filter((r) => hit(r.cells));
    return { columns, rows };
  }, [view, data, staff, month, companyInScope, entityName, nameOf, paidFromCell, csOptions, payFrom, hit]);

  const dock = view === "payslips" ? payDock : view === "adjustments" ? adjDock : null;
  const dockOpen = !!dock && canManage;

  // ---- what the selection can do ----
  const selected = selectedIds.map(Number);
  const one = selected.length === 1 ? selected[0] : null;
  const selStaff = view === "staff" && one != null ? staff.find((s) => s.user_id === one) : undefined;
  const selPay = view === "payslips" && one != null ? data?.payments.find((p) => p.salary_id === one) : undefined;
  const selAdj = view === "adjustments" && one != null ? data?.adjustments.find((a) => a.adjustment_id === one) : undefined;

  const doConfirm = async () => {
    if (!confirming) return;
    const res =
      confirming.kind === "reverse"
        ? await send(`/api/salaries/${confirming.salary.salary_id}/reverse`, "POST")
        : await send(`/api/salary-adjustments/${confirming.adj.adjustment_id}`, "DELETE");
    if (!res.ok) return void toast.error(res.error);
    toast.success(confirming.kind === "reverse" ? "Salary reversed — money back on the account" : "Adjustment removed");
    setSelectedIds([]);
    await afterSave();
  };

  return (
    <>
      <div className="shrink-0 space-y-1.5 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-page-search
            placeholder="Search rows…"
            className="h-8 w-52 text-[13px]"
          />
          <div className="flex items-center gap-1" role="group" aria-label="View">
            {VIEWS.map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => switchView(v)}
                className={cn(
                  "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                  view === v
                    ? "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500"
                    : "border-border bg-background text-muted-foreground hover:border-emerald-600/50 hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {view === "staff" && (
            <Input
              type="month"
              value={month}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
              className="h-8 w-[150px] text-[13px]"
              title="Days worked and off for this month"
            />
          )}
          <span className="text-xs text-muted-foreground">
            {rows.length} row{rows.length === 1 ? "" : "s"}
          </span>
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}

          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 cursor-pointer gap-1.5" onClick={() => setBasesOpen(true)}>
              <Wallet className="h-3.5 w-3.5" />
              Base salaries
            </Button>
            <Button size="sm" variant="outline" className="h-8 cursor-pointer gap-1.5" onClick={() => void reload()}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
            {dockOpen && dock && (
              <Button
                size="sm"
                className="h-8 cursor-pointer gap-1.5 bg-emerald-700 text-white hover:bg-emerald-800"
                disabled={dock.saving || dock.readyCount === 0}
                onClick={() => void dock.commit()}
              >
                {dock.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {view === "payslips" ? "Pay" : "Save"}{" "}
                {dock.readyCount > 0 ? `${dock.readyCount} row${dock.readyCount === 1 ? "" : "s"}` : "rows"}
                <span className="hidden text-[10px] opacity-70 lg:inline">{MOD_LABEL}S</span>
              </Button>
            )}
          </div>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <SheetGrid
          key={`salary:${view}`}
          widthStorageKey={`transactions:salary:${view}`}
          columns={columns}
          rows={rows}
          drafts={dockOpen && dock ? dock.drafts : []}
          onDraftsChange={dockOpen && dock ? dock.onDraftsChange : noop}
          draftStatus={dockOpen && dock ? dock.draftStatus : noDraftStatus}
          flushRef={dockOpen && dock ? dock.flushRef : undefined}
          readOnly={!dockOpen}
          onSelectedRowsChange={setSelectedIds}
          focusKey={`salary:${view}:${!!data}`}
        />
      )}

      {!isViewer && selectedIds.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-14 z-40 flex justify-center">
          <div className="pointer-events-auto flex max-w-[92%] flex-wrap items-center justify-center gap-1.5 rounded-lg border border-emerald-600/40 bg-background/95 px-3 py-1.5 shadow-xl backdrop-blur">
            <span className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-300">
              {selectedIds.length} selected
            </span>
            <button
              type="button"
              onClick={() => setSelectedIds([])}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
              title="Clear selection"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            {selStaff && (
              <Button size="xs" variant="outline" className="cursor-pointer gap-1" onClick={() => setDaysFor(selStaff.user_id)}>
                <CalendarDays className="h-3 w-3" /> Day by day
              </Button>
            )}
            {selPay && canManage && selPay.status === "paid" && (
              <Button
                size="xs"
                variant="outline"
                className="cursor-pointer gap-1 text-red-700 dark:text-red-400"
                onClick={() => setConfirming({ kind: "reverse", salary: selPay })}
              >
                <Undo2 className="h-3 w-3" /> Reverse
              </Button>
            )}
            {selAdj && canManage && !selAdj.salary_id && (selAdj.kind === "bonus" || selAdj.kind === "deduction" || selAdj.kind === "advance") && (
              <Button
                size="xs"
                variant="outline"
                className="cursor-pointer gap-1 text-red-700 dark:text-red-400"
                onClick={() => setConfirming({ kind: "remove", adj: selAdj })}
              >
                <Trash2 className="h-3 w-3" /> Remove
              </Button>
            )}
            {selected.length > 1 && <span className="text-[11px] text-muted-foreground">Pick one row to act on it</span>}
          </div>
        </div>
      )}

      <AttendanceModal
        open={daysFor !== null}
        onOpenChange={(o) => !o && setDaysFor(null)}
        userId={daysFor}
        month={month}
        canMark={canManage && !staff.find((s) => s.user_id === daysFor)?.paid_salary_id}
        onChanged={() => void reload()}
      />
      <BaseSalaryModal
        open={basesOpen}
        onOpenChange={setBasesOpen}
        staff={staff}
        canManage={canManage}
        onDone={() => void afterSave()}
      />
      {confirming && (
        <ConfirmActionDialog
          open
          onOpenChange={(o) => !o && setConfirming(null)}
          title={confirming.kind === "reverse" ? "Reverse this salary?" : "Remove this adjustment?"}
          description={
            confirming.kind === "reverse"
              ? "The money goes back on the account it was paid from, and its bonuses, deductions and penalties wait for the next salary again."
              : "It won't be on the next salary."
          }
          summary={
            confirming.kind === "reverse"
              ? [
                  { label: "CS", value: nameOf(confirming.salary.user_id) },
                  { label: "Month", value: monthLabel(confirming.salary.period_month) },
                  { label: "Paid from", value: paidFromCell(confirming.salary) },
                  { label: "Back to the account", value: formatRM(confirming.salary.net_amount), emphasis: true },
                ]
              : [
                  { label: "CS", value: nameOf(confirming.adj.user_id) },
                  { label: ADJUSTMENT_LABEL[confirming.adj.kind], value: confirming.adj.reason },
                  { label: "Amount", value: signed(confirming.adj.amount), emphasis: true },
                ]
          }
          confirmLabel={confirming.kind === "reverse" ? "Reverse salary" : "Remove"}
          tone="danger"
          onConfirm={doConfirm}
        />
      )}
    </>
  );
}

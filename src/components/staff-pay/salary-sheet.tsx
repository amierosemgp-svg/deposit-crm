"use client";

/**
 * The Salary worksheet tab: who worked how long this month and what that pays,
 * the payslips, and the bonuses / deductions / penalties waiting on the next
 * one. Rows are read-only — a salary is never typed, it is worked out — and
 * everything that changes money goes through a dialog that shows the figure.
 */

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Banknote, Clock, Gift, Layers, Loader2, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { SheetGrid, type SheetColumn, type SheetRow } from "@/components/sheet/sheet-grid";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";
import { formatRM, formatShortDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PaySalaryModal } from "./pay-salary-modal";
import { AdjustmentModal, HoursModal } from "./staff-pay-dialogs";
import { TiersModal } from "./tiers-modal";
import {
  ADJUSTMENT_LABEL,
  currentMonth,
  monthLabel,
  send,
  useStaffPay,
  type SalaryAdjustment,
  type SalaryPayment,
} from "./use-staff-pay";

type View = "staff" | "payslips" | "adjustments";

const VIEWS: Array<[View, string]> = [
  ["staff", "Staff & hours"],
  ["payslips", "Payslips"],
  ["adjustments", "Adjustments"],
];

const fmt = (n: number) =>
  n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number) => (n === 0 ? "—" : `${n > 0 ? "+" : "−"}${fmt(Math.abs(n))}`);
const noop = () => {};
const noDraftStatus = () => ({ state: "empty" as const });

export function SalarySheet() {
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const bankAccounts = useStore((s) => s.bankAccounts);
  const entityName = useStore((s) => s.entityName);
  const companyInScope = useStore((s) => s.companyInScope);
  const refreshStore = useStore((s) => s.refresh);
  const isViewer = me?.role === "viewer";
  const canManage = me?.role === "super_admin" || me?.role === "company_leader";

  const [month, setMonth] = useState(currentMonth);
  const [view, setView] = useState<View>("staff");
  const { data, loading, error, reload } = useStaffPay(month);
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [search, setSearch] = useState("");

  const [payFor, setPayFor] = useState<{ open: boolean; userId: number | null }>({ open: false, userId: null });
  const [hoursFor, setHoursFor] = useState<number | null>(null);
  const [adjOpen, setAdjOpen] = useState(false);
  const [tiersOpen, setTiersOpen] = useState(false);
  const [confirming, setConfirming] = useState<
    { kind: "reverse"; salary: SalaryPayment } | { kind: "remove"; adj: SalaryAdjustment } | null
  >(null);

  const after = useCallback(async () => {
    await Promise.all([reload(), refreshStore()]);
  }, [reload, refreshStore]);

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
  const paidFrom = useCallback(
    (p: SalaryPayment) => {
      if (p.paid_from_account_id) {
        const a = bankAccounts.find((x) => x.account_id === p.paid_from_account_id);
        return a ? `${a.label?.trim() || a.bank_name} · ${a.account_number}` : `Account #${p.paid_from_account_id}`;
      }
      if (p.paid_from_cash_entity_id) return `Cash · ${entityName(p.paid_from_cash_entity_id)}`;
      return p.net_amount === 0 ? "—" : "";
    },
    [bankAccounts, entityName],
  );

  const q = search.trim().toLowerCase();
  const hit = (cells: string[]) => !q || cells.some((c) => c.toLowerCase().includes(q));

  const { columns, rows } = useMemo((): { columns: SheetColumn[]; rows: SheetRow[] } => {
    if (view === "staff") {
      const columns: SheetColumn[] = [
        { key: "cs", label: "CS", width: 180 },
        { key: "casino", label: "Casino", width: 140 },
        { key: "hours", label: "Hours", width: 80, align: "right", numeric: true },
        { key: "days", label: "Days", width: 64, align: "right", numeric: true },
        { key: "tier", label: "Tier Reached", width: 140 },
        { key: "base", label: "Tier Pay", width: 100, align: "right", numeric: true },
        { key: "pending", label: "Pending Adj.", width: 110, align: "right", numeric: true },
        { key: "net", label: "Would Pay", width: 110, align: "right", numeric: true },
        { key: "status", label: `${monthLabel(month)}`, width: 110, align: "center" },
      ];
      const rows = staff
        .slice()
        .sort((a, b) => a.full_name.localeCompare(b.full_name))
        .map((s): SheetRow => {
          const net = s.base + s.pending_adjustments;
          return {
            id: s.user_id,
            tone: s.paid_salary_id ? "success" : s.status === "inactive" ? "muted" : "default",
            cells: [
              s.full_name + (s.status === "inactive" ? " (inactive)" : ""),
              entityName(s.company_entity_id),
              String(s.hours),
              String(s.days),
              s.tier_name ?? "No tier yet",
              fmt(s.base),
              signed(s.pending_adjustments),
              s.paid_salary_id ? "" : net < 0 ? `0.00 (−${fmt(-net)} carries)` : fmt(net),
              s.paid_salary_id ? "Paid" : "Not paid",
            ],
          };
        })
        .filter((r) => hit(r.cells));
      return { columns, rows };
    }

    if (view === "payslips") {
      const columns: SheetColumn[] = [
        { key: "month", label: "Month", width: 84 },
        { key: "cs", label: "CS", width: 160 },
        { key: "casino", label: "Casino", width: 130 },
        { key: "hours", label: "Hours", width: 70, align: "right", numeric: true },
        { key: "days", label: "Days", width: 56, align: "right", numeric: true },
        { key: "tier", label: "Tier", width: 120 },
        { key: "base", label: "Tier Pay", width: 96, align: "right", numeric: true },
        { key: "adj", label: "Adjustments", width: 100, align: "right", numeric: true },
        { key: "net", label: "Paid", width: 100, align: "right", numeric: true },
        { key: "carry", label: "Carried", width: 84, align: "right", numeric: true },
        { key: "from", label: "Paid From", width: 190 },
        { key: "status", label: "Status", width: 90, align: "center" },
        { key: "at", label: "Paid At", width: 130 },
        { key: "by", label: "By", width: 110 },
        { key: "notes", label: "Notes", width: 200 },
      ];
      const rows = (data?.payments ?? [])
        .filter((p) => companyInScope(p.company_entity_id))
        .map((p): SheetRow => ({
          id: p.salary_id,
          tone: p.status === "reversed" ? "muted" : "default",
          cells: [
            monthLabel(p.period_month),
            nameOf(p.user_id),
            entityName(p.company_entity_id),
            String(p.hours_worked),
            String(p.days_worked),
            p.tier_name
              ? `${p.tier_name}${p.tier_basis === "hourly" ? ` @ ${fmt(p.tier_rate ?? 0)}/h` : ""}`
              : "No tier",
            fmt(p.base_amount),
            signed(p.adjustments_total),
            fmt(p.net_amount),
            p.carried_forward ? fmt(p.carried_forward) : "—",
            paidFrom(p),
            p.status === "reversed" ? "Reversed" : "Paid",
            formatShortDateTime(p.paid_at),
            nameOf(p.recorded_by_user_id),
            p.notes ?? "",
          ],
        }))
        .filter((r) => hit(r.cells));
      return { columns, rows };
    }

    const payMonth = new Map((data?.payments ?? []).map((p) => [p.salary_id, p.period_month]));
    const columns: SheetColumn[] = [
      { key: "date", label: "Date", width: 92, align: "center" },
      { key: "cs", label: "CS", width: 160 },
      { key: "kind", label: "Type", width: 120 },
      { key: "reason", label: "Reason", width: 280 },
      { key: "amount", label: "Amount", width: 100, align: "right", numeric: true },
      { key: "status", label: "Status", width: 170 },
      { key: "by", label: "By", width: 110 },
    ];
    const rows = (data?.adjustments ?? [])
      .filter((a) => companyInScope(a.company_entity_id))
      .map((a): SheetRow => ({
        id: a.adjustment_id,
        tone: a.salary_id ? "muted" : a.amount > 0 ? "success" : "warning",
        cells: [
          new Date(a.occurred_at).toLocaleDateString("en-MY", { timeZone: "Asia/Kuala_Lumpur" }),
          nameOf(a.user_id),
          ADJUSTMENT_LABEL[a.kind],
          a.reason,
          signed(a.amount),
          a.salary_id
            ? `In ${monthLabel(payMonth.get(a.salary_id) ?? "")} salary`
            : "Pending — next salary",
          nameOf(a.created_by_user_id),
        ],
      }))
      .filter((r) => hit(r.cells));
    return { columns, rows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, data, staff, month, q, companyInScope, entityName, nameOf, paidFrom]);

  // ---- what the selection can do ----
  const selected = selectedIds.map(Number);
  const one = selected.length === 1 ? selected[0] : null;
  const selStaff = view === "staff" && one != null ? staff.find((s) => s.user_id === one) : undefined;
  const selPay =
    view === "payslips" && one != null ? data?.payments.find((p) => p.salary_id === one) : undefined;
  const selAdj =
    view === "adjustments" && one != null ? data?.adjustments.find((a) => a.adjustment_id === one) : undefined;

  const doConfirm = async () => {
    if (!confirming) return;
    const res =
      confirming.kind === "reverse"
        ? await send(`/api/salaries/${confirming.salary.salary_id}/reverse`, "POST")
        : await send(`/api/salary-adjustments/${confirming.adj.adjustment_id}`, "DELETE");
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(confirming.kind === "reverse" ? "Salary reversed — money back on the account" : "Adjustment removed");
    setSelectedIds([]);
    await after();
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
          <Input
            type="month"
            value={month}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="h-8 w-[150px] text-[13px]"
            title="Hours and tier for this month"
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
          <span className="text-xs text-muted-foreground">
            {rows.length} row{rows.length === 1 ? "" : "s"}
          </span>
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}

          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 cursor-pointer gap-1.5" onClick={() => setTiersOpen(true)}>
              <Layers className="h-3.5 w-3.5" />
              Salary tiers
            </Button>
            {canManage && (
              <Button size="sm" variant="outline" className="h-8 cursor-pointer gap-1.5" onClick={() => setAdjOpen(true)}>
                <Gift className="h-3.5 w-3.5" />
                Bonus / deduction
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-8 cursor-pointer gap-1.5" onClick={() => void reload()}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
            {canManage && (
              <Button
                size="sm"
                className="h-8 cursor-pointer gap-1.5 bg-emerald-700 text-white hover:bg-emerald-800"
                onClick={() => setPayFor({ open: true, userId: selStaff?.user_id ?? null })}
              >
                <Banknote className="h-3.5 w-3.5" />
                Pay salary
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
          drafts={[]}
          onDraftsChange={noop}
          draftStatus={noDraftStatus}
          readOnly
          onSelectedRowsChange={setSelectedIds}
          focusKey={`salary:${view}`}
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
              <Button size="xs" variant="outline" className="cursor-pointer gap-1" onClick={() => setHoursFor(selStaff.user_id)}>
                <Clock className="h-3 w-3" /> Day by day
              </Button>
            )}
            {selStaff && canManage && !selStaff.paid_salary_id && (
              <Button
                size="xs"
                className="cursor-pointer gap-1 bg-emerald-700 text-white hover:bg-emerald-800"
                onClick={() => setPayFor({ open: true, userId: selStaff.user_id })}
              >
                <Banknote className="h-3 w-3" /> Pay {monthLabel(month)}
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
            {selAdj && canManage && !selAdj.salary_id && (selAdj.kind === "bonus" || selAdj.kind === "deduction") && (
              <Button
                size="xs"
                variant="outline"
                className="cursor-pointer gap-1 text-red-700 dark:text-red-400"
                onClick={() => setConfirming({ kind: "remove", adj: selAdj })}
              >
                <Trash2 className="h-3 w-3" /> Remove
              </Button>
            )}
            {selected.length > 1 && (
              <span className="text-[11px] text-muted-foreground">Pick one row to act on it</span>
            )}
          </div>
        </div>
      )}

      <PaySalaryModal
        open={payFor.open}
        onOpenChange={(o) => setPayFor((p) => ({ ...p, open: o }))}
        staff={staff}
        month={month}
        userId={payFor.userId}
        onDone={() => void after()}
      />
      <HoursModal open={hoursFor !== null} onOpenChange={(o) => !o && setHoursFor(null)} userId={hoursFor} month={month} />
      <AdjustmentModal open={adjOpen} onOpenChange={setAdjOpen} staff={staff} onDone={() => void reload()} />
      <TiersModal
        open={tiersOpen}
        onOpenChange={setTiersOpen}
        tiers={data?.tiers ?? []}
        rates={data?.rates ?? []}
        staff={staff}
        onDone={() => void reload()}
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
                  { label: "Paid from", value: paidFrom(confirming.salary) || "—" },
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

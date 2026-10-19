"use client";

/**
 * The Staff Penalty worksheet tab: credit lost through a CS's mistake and the
 * share they bear. Recorded here, deducted by their next salary without anyone
 * ticking it — the Status column says which salary took it.
 */

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Ban, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { SheetGrid, type SheetColumn, type SheetRow } from "@/components/sheet/sheet-grid";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PenaltyModal } from "./staff-pay-dialogs";
import {
  currentMonth,
  monthLabel,
  PENALTY_SOURCE_LABEL,
  send,
  useStaffPay,
  type StaffPenalty,
} from "./use-staff-pay";

const fmt = (n: number) =>
  n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const noop = () => {};
const noDraftStatus = () => ({ state: "empty" as const });

const STATUS_PILLS: Array<[string, string]> = [
  ["pending", "Pending"],
  ["deducted", "Deducted"],
  ["void", "Void"],
];

export function PenaltySheet() {
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const entityName = useStore((s) => s.entityName);
  const companyInScope = useStore((s) => s.companyInScope);
  const isViewer = me?.role === "viewer";
  const canVoid = me?.role === "super_admin" || me?.role === "company_leader";

  // The month only matters to the staff list the dialog offers; penalties
  // are listed whole.
  const { data, loading, error, reload } = useStaffPay(currentMonth());
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(() => new Set());
  const [newOpen, setNewOpen] = useState(false);
  const [voiding, setVoiding] = useState<StaffPenalty | null>(null);

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

  // Which salary took each penalty, through its adjustment.
  const deductedIn = useMemo(() => {
    const months = new Map((data?.payments ?? []).map((p) => [p.salary_id, p.period_month]));
    const m = new Map<number, string>();
    for (const a of data?.adjustments ?? []) {
      if (a.penalty_id && a.salary_id) m.set(a.penalty_id, months.get(a.salary_id) ?? "");
    }
    return m;
  }, [data]);

  const statusOf = useCallback(
    (p: StaffPenalty) => (p.status === "void" ? "void" : deductedIn.has(p.penalty_id) ? "deducted" : "pending"),
    [deductedIn],
  );

  const columns: SheetColumn[] = [
    { key: "date", label: "Date", width: 92, align: "center" },
    { key: "cs", label: "CS", width: 160 },
    { key: "casino", label: "Casino", width: 130 },
    { key: "source", label: "Mistake On", width: 110 },
    { key: "ref", label: "Ref", width: 70, align: "right" },
    { key: "injected", label: "Credited", width: 96, align: "right", numeric: true },
    { key: "retrieved", label: "Retrieved", width: 96, align: "right", numeric: true },
    { key: "lost", label: "Lost", width: 90, align: "right", numeric: true },
    { key: "share", label: "Share", width: 64, align: "right" },
    { key: "amount", label: "Penalty", width: 96, align: "right", numeric: true },
    { key: "reason", label: "What Happened", width: 260 },
    { key: "status", label: "Status", width: 150 },
    { key: "by", label: "Recorded By", width: 120 },
  ];

  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (data?.penalties ?? [])
        .filter((p) => companyInScope(p.company_entity_id))
        .filter((p) => statusFilter.size === 0 || statusFilter.has(statusOf(p)))
        .map((p): SheetRow => {
          const st = statusOf(p);
          return {
            id: p.penalty_id,
            tone: st === "void" ? "muted" : st === "deducted" ? "default" : "warning",
            cells: [
              new Date(p.occurred_at).toLocaleDateString("en-MY", { timeZone: "Asia/Kuala_Lumpur" }),
              nameOf(p.user_id),
              entityName(p.company_entity_id),
              PENALTY_SOURCE_LABEL[p.source_type],
              p.source_id ? `#${p.source_id}` : "",
              fmt(p.credit_injected),
              fmt(p.credit_retrieved),
              fmt(p.loss_amount),
              `${p.share_pct}%`,
              fmt(p.amount),
              p.reason,
              st === "void"
                ? "Void"
                : st === "deducted"
                  ? `Deducted · ${monthLabel(deductedIn.get(p.penalty_id) ?? "")} salary`
                  : "Pending — next salary",
              nameOf(p.recorded_by_user_id),
            ],
          };
        })
        .filter((r) => !q || r.cells.some((c) => c.toLowerCase().includes(q))),
    [data, companyInScope, statusFilter, statusOf, nameOf, entityName, deductedIn, q],
  );

  const one = selectedIds.length === 1 ? Number(selectedIds[0]) : null;
  const sel = one != null ? data?.penalties.find((p) => p.penalty_id === one) : undefined;

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
          <div className="flex items-center gap-1" role="group" aria-label="Status">
            {STATUS_PILLS.map(([v, label]) => {
              const on = statusFilter.has(v);
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setStatusFilter((prev) => {
                      const next = new Set(prev);
                      if (next.has(v)) next.delete(v);
                      else next.add(v);
                      return next;
                    })
                  }
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                    on
                      ? "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500"
                      : "border-border bg-background text-muted-foreground hover:border-emerald-600/50 hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-muted-foreground">
            {rows.length} row{rows.length === 1 ? "" : "s"}
          </span>
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 cursor-pointer gap-1.5" onClick={() => void reload()}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
            {!isViewer && (
              <Button
                size="sm"
                className="h-8 cursor-pointer gap-1.5 bg-emerald-700 text-white hover:bg-emerald-800"
                onClick={() => setNewOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                New penalty
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
          key="penalty"
          widthStorageKey="transactions:penalty"
          columns={columns}
          rows={rows}
          drafts={[]}
          onDraftsChange={noop}
          draftStatus={noDraftStatus}
          readOnly
          onSelectedRowsChange={setSelectedIds}
          focusKey="penalty"
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
            {sel && canVoid && statusOf(sel) === "pending" && (
              <Button
                size="xs"
                variant="outline"
                className="cursor-pointer gap-1 text-red-700 dark:text-red-400"
                onClick={() => setVoiding(sel)}
              >
                <Ban className="h-3 w-3" /> Void
              </Button>
            )}
            {sel && statusOf(sel) === "deducted" && (
              <span className="text-[11px] text-muted-foreground">
                Already deducted — reverse that salary to change it
              </span>
            )}
            {selectedIds.length > 1 && (
              <span className="text-[11px] text-muted-foreground">Pick one row to act on it</span>
            )}
          </div>
        </div>
      )}

      <PenaltyModal
        open={newOpen}
        onOpenChange={setNewOpen}
        staff={staff}
        sharePct={data?.share_pct ?? 50}
        onDone={() => void reload()}
      />
      {voiding && (
        <ConfirmActionDialog
          open
          onOpenChange={(o) => !o && setVoiding(null)}
          title="Void this penalty?"
          description="It comes off their next salary's deductions. The record stays, marked void."
          summary={[
            { label: "CS", value: nameOf(voiding.user_id) },
            { label: "What happened", value: voiding.reason },
            { label: "Penalty", value: formatRM(voiding.amount), emphasis: true },
          ]}
          confirmLabel="Void penalty"
          tone="danger"
          onConfirm={async () => {
            const res = await send(`/api/staff-penalties/${voiding.penalty_id}`, "DELETE");
            if (!res.ok) return void toast.error(res.error);
            toast.success("Penalty voided");
            setSelectedIds([]);
            await reload();
          }}
        />
      )}
    </>
  );
}

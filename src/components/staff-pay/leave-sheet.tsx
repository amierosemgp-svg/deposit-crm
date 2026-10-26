"use client";

/**
 * The Leave worksheet tab: every CS leave, From–To, MC / annual / emergency /
 * other, told or not, and why. Typed into the NEW ENTRIES dock like any other
 * sheet. It is what attendance reads — each day a leave covers is a day off,
 * told or not as recorded; a day off with no leave is untold.
 */

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Ban, Loader2, RefreshCw, Save, X } from "lucide-react";
import { SheetGrid, type SheetColumn, type SheetRow } from "@/components/sheet/sheet-grid";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { parseSheetDate, todaySheetDate, useEntryDock, type Parsed } from "./entry-dock";
import { CsProfileButton, CsProfileModal, useCsProfileShortcut } from "./cs-profile-modal";
import {
  currentMonth,
  LEAVE_KIND_LABEL,
  leaveDays,
  monthLabel,
  send,
  sheetDay,
  useStaffPay,
  type LeaveKind,
  type StaffLeave,
  type StaffRow,
} from "./use-staff-pay";

const noop = () => {};
const noDraftStatus = () => ({ state: "empty" as const });
const MOD_LABEL = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

const STATUS_PILLS: Array<[StaffLeave["status"], string]> = [
  ["active", "Active"],
  ["void", "Void"],
];

const KINDS = Object.entries(LEAVE_KIND_LABEL) as Array<[LeaveKind, string]>;
const TOLD = "Told";
const NOT_TOLD = "Not told";

// Columns, saved rows and the dock alike.
const C = { from: 0, to: 1, days: 2, cs: 3, casino: 4, kind: 5, told: 6, reason: 7, status: 8, by: 9 } as const;
const N_COLS = 10;

/** "MC", "annual", "Emergency leave", "e" → the kind. */
function parseKind(cell: string): LeaveKind | null {
  const v = cell.trim().toLowerCase();
  if (!v) return null;
  return KINDS.find(([k, label]) => k === v || label.toLowerCase() === v)?.[0] ?? KINDS.find(([k]) => k.startsWith(v))?.[0] ?? null;
}

/** "Told" / "yes" → true, "Not told" / "no" → false. */
function parseTold(cell: string): boolean | null {
  const v = cell.trim().toLowerCase();
  if (["told", "yes", "y"].includes(v)) return true;
  if (["not told", "no", "n", "untold"].includes(v)) return false;
  return null;
}

/** From and To off a row — To blank means a single day. */
function rangeOf(row: string[]) {
  const from = parseSheetDate(row[C.from] ?? "");
  const toCell = (row[C.to] ?? "").trim();
  const to = toCell ? parseSheetDate(toCell) : from;
  return { from, to, toCell };
}

export function LeaveSheet() {
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const entityName = useStore((s) => s.entityName);
  const companyInScope = useStore((s) => s.companyInScope);
  const isViewer = me?.role === "viewer";
  const canVoid = me?.role === "super_admin" || me?.role === "company_leader";
  // A CS can't record their own leave (the server refuses it too).
  const selfId = me?.role === "cs_agent" ? me.user_id : null;

  const { data, loading, error, reload } = useStaffPay(currentMonth());
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [selectedDrafts, setSelectedDrafts] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(() => new Set(["active"]));
  const [voiding, setVoiding] = useState<StaffLeave | null>(null);
  const [profileFor, setProfileFor] = useState<number | null>(null);

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

  const pickable = useMemo(
    () => staff.filter((s) => s.status === "active" && s.user_id !== selfId),
    [staff, selfId],
  );
  const csOptions = useMemo(
    () =>
      pickable
        .slice()
        .sort((a, b) => a.full_name.localeCompare(b.full_name))
        .map((s) => ({ value: s.full_name, hint: `${s.username} · ${entityName(s.company_entity_id)}` })),
    [pickable, entityName],
  );
  const resolveCs = useCallback(
    (cell: string): StaffRow | null => {
      const v = cell.trim().toLowerCase();
      if (!v) return null;
      return (
        pickable.find((s) => s.full_name.toLowerCase() === v) ??
        pickable.find((s) => s.username.toLowerCase() === v) ??
        null
      );
    },
    [pickable],
  );

  /** An active leave of this CS overlapping the range, if any. */
  const clashWith = useCallback(
    (userId: number, from: string, to: string) =>
      (data?.leaves ?? []).find((l) => l.user_id === userId && l.status === "active" && l.from_day <= to && l.to_day >= from),
    [data],
  );
  /** A paid month the range touches, if any. */
  const paidMonthIn = useCallback(
    (userId: number, from: string, to: string) =>
      (data?.payments ?? []).find(
        (p) => p.user_id === userId && p.status === "paid" && p.period_month >= from.slice(0, 7) && p.period_month <= to.slice(0, 7),
      )?.period_month,
    [data],
  );

  // ---- the dock ----

  const autoCells = useCallback((): Array<[number, string]> => [[C.from, todaySheetDate()]], []);

  const derive = useCallback(
    (rows: string[][]) =>
      rows.map((row) => {
        const next = [...row];
        for (const c of [C.days, C.casino, C.status, C.by]) next[c] = "";
        const { from, to } = rangeOf(row);
        if (from && to && to >= from) {
          const n = leaveDays({ from_day: from, to_day: to });
          next[C.days] = String(n);
        }
        const cs = resolveCs(row[C.cs] ?? "");
        if (cs) next[C.casino] = entityName(cs.company_entity_id);
        return next;
      }),
    [resolveCs, entityName],
  );

  type Body = { user_id: number; from_day: string; to_day: string; kind: LeaveKind; notified: boolean; reason: string };
  const parse = useCallback(
    (row: string[]): Parsed<Body> => {
      const { from, to, toCell } = rangeOf(row);
      if (!from) return { ok: false, error: `From: bad date "${(row[C.from] ?? "").trim()}" (use 31/8/2026)` };
      if (!to) return { ok: false, error: `To: bad date "${toCell}" (use 31/8/2026, or leave it blank for one day)` };
      if (to < from) return { ok: false, error: "To is before From" };
      if (leaveDays({ from_day: from, to_day: to }) > 31) return { ok: false, error: "A leave is at most 31 days — split it" };

      const csCell = (row[C.cs] ?? "").trim();
      if (!csCell) return { ok: false, error: "Who — pick the CS" };
      const cs = resolveCs(csCell);
      if (!cs) {
        const isSelf =
          selfId != null &&
          staff.some((s) => s.user_id === selfId && [s.full_name, s.username].some((n) => n.toLowerCase() === csCell.toLowerCase()));
        return { ok: false, error: isSelf ? "Ask a colleague or your leader to record your leave" : `No CS called "${csCell}" — pick from the list` };
      }
      const kind = parseKind(row[C.kind] ?? "");
      if (!kind) return { ok: false, error: `Type is one of ${KINDS.map(([, l]) => l).join(", ")}` };
      const notified = parseTold(row[C.told] ?? "");
      if (notified === null) return { ok: false, error: `Told? — "${TOLD}" if the leader knew beforehand, else "${NOT_TOLD}"` };
      const reason = (row[C.reason] ?? "").trim();
      if (!reason) return { ok: false, error: "Reason — what the leave is for" };

      const paid = paidMonthIn(cs.user_id, from, to);
      if (paid) return { ok: false, error: `${monthLabel(paid)} is already paid for ${cs.full_name} — reverse it first` };
      const clash = clashWith(cs.user_id, from, to);
      if (clash) {
        return {
          ok: false,
          error: `${cs.full_name} already has leave ${sheetDay(clash.from_day)}${clash.to_day !== clash.from_day ? `–${sheetDay(clash.to_day)}` : ""}`,
        };
      }
      return { ok: true, body: { user_id: cs.user_id, from_day: from, to_day: to, kind, notified, reason } };
    },
    [resolveCs, selfId, staff, paidMonthIn, clashWith],
  );

  const dock = useEntryDock<Body>({
    nCols: N_COLS,
    autoCells,
    derive,
    parse,
    submit: async (body) => {
      const res = await send("/api/staff-leaves", "POST", body);
      return res.ok ? { ok: true } : res;
    },
    noun: (n) => (n === 1 ? "leave" : "leaves"),
    onSaved: () => reload(),
    enabled: !isViewer,
  });

  // ---- the sheet ----

  const columns: SheetColumn[] = [
    { key: "from", label: "From", width: 92, align: "center", entry: true, required: true, placeholder: todaySheetDate() },
    { key: "to", label: "To", width: 92, align: "center", entry: true, placeholder: "same day" },
    { key: "days", label: "Days", width: 56, align: "right", numeric: true },
    { key: "cs", label: "CS", width: 160, entry: true, required: true, options: csOptions, placeholder: "who" },
    { key: "casino", label: "Casino", width: 130 },
    { key: "kind", label: "Type", width: 130, entry: true, required: true, options: KINDS.map(([, l]) => l) },
    { key: "told", label: "Told?", width: 90, entry: true, required: true, options: [TOLD, NOT_TOLD] },
    { key: "reason", label: "Reason", width: 260, entry: true, required: true, placeholder: "what it's for" },
    { key: "status", label: "Status", width: 90 },
    { key: "by", label: "Recorded By", width: 120 },
  ];

  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (data?.leaves ?? [])
        .filter((l) => companyInScope(l.company_entity_id))
        .filter((l) => statusFilter.size === 0 || statusFilter.has(l.status))
        .slice()
        .sort((a, b) => a.from_day.localeCompare(b.from_day))
        .map((l): SheetRow => {
          const cells = Array<string>(N_COLS).fill("");
          cells[C.from] = sheetDay(l.from_day);
          cells[C.to] = sheetDay(l.to_day);
          cells[C.days] = String(leaveDays(l));
          cells[C.cs] = nameOf(l.user_id);
          cells[C.casino] = entityName(l.company_entity_id);
          cells[C.kind] = LEAVE_KIND_LABEL[l.kind];
          cells[C.told] = l.notified ? TOLD : NOT_TOLD;
          cells[C.reason] = l.reason;
          cells[C.status] = l.status === "void" ? "Void" : "Active";
          cells[C.by] = nameOf(l.recorded_by_user_id);
          return { id: l.leave_id, tone: l.status === "void" ? "muted" : l.notified ? "default" : "warning", cells };
        })
        .filter((r) => !q || r.cells.some((c) => c.toLowerCase().includes(q))),
    [data, companyInScope, statusFilter, nameOf, entityName, q],
  );

  // The CS behind the selection, saved rows and NEW ENTRIES rows alike —
  // only when it's one person.
  const selectedCs = useMemo(() => {
    const ids = new Set<number>();
    for (const id of selectedIds) {
      const uid = data?.leaves.find((l) => l.leave_id === Number(id))?.user_id;
      if (uid) ids.add(uid);
    }
    if (!isViewer) {
      for (const i of selectedDrafts) {
        const cs = resolveCs(dock.drafts[i]?.[C.cs] ?? "");
        if (cs) ids.add(cs.user_id);
      }
    }
    return ids.size === 1 ? [...ids][0] : null;
  }, [selectedIds, selectedDrafts, data, isViewer, dock.drafts, resolveCs]);
  useCsProfileShortcut(profileFor ? null : selectedCs, setProfileFor);

  const one = selectedIds.length === 1 ? Number(selectedIds[0]) : null;
  const sel = one != null ? data?.leaves.find((l) => l.leave_id === one) : undefined;

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
                disabled={dock.saving || dock.readyCount === 0}
                onClick={() => void dock.commit()}
              >
                {dock.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save {dock.readyCount > 0 ? `${dock.readyCount} row${dock.readyCount === 1 ? "" : "s"}` : "rows"}
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
          key="leave"
          widthStorageKey="transactions:leave"
          columns={columns}
          rows={rows}
          drafts={isViewer ? [] : dock.drafts}
          onDraftsChange={isViewer ? noop : dock.onDraftsChange}
          draftStatus={isViewer ? noDraftStatus : dock.draftStatus}
          flushRef={isViewer ? undefined : dock.flushRef}
          readOnly={isViewer}
          onSelectedRowsChange={setSelectedIds}
          onSelectedDraftsChange={setSelectedDrafts}
          focusKey={`leave:${!!data}`}
        />
      )}

      {(selectedIds.length > 0 || selectedCs) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-14 z-40 flex justify-center">
          <div className="pointer-events-auto flex max-w-[92%] flex-wrap items-center justify-center gap-1.5 rounded-lg border border-emerald-600/40 bg-background/95 px-3 py-1.5 shadow-xl backdrop-blur">
            {selectedIds.length > 0 && (
              <>
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
              </>
            )}
            {selectedCs && <CsProfileButton onClick={() => setProfileFor(selectedCs)} />}
            {sel && canVoid && sel.status === "active" && (
              <Button
                size="xs"
                variant="outline"
                className="cursor-pointer gap-1 text-red-700 dark:text-red-400"
                onClick={() => setVoiding(sel)}
              >
                <Ban className="h-3 w-3" /> Void
              </Button>
            )}
            {selectedIds.length > 1 && !selectedCs && (
              <span className="text-[11px] text-muted-foreground">Pick one row to act on it</span>
            )}
          </div>
        </div>
      )}

      <CsProfileModal
        open={profileFor !== null}
        onOpenChange={(o) => !o && setProfileFor(null)}
        userId={profileFor}
        initialSection="leave"
      />

      {voiding && (
        <ConfirmActionDialog
          open
          onOpenChange={(o) => !o && setVoiding(null)}
          title="Void this leave?"
          description="Its days go back to what the clock says — a day off with no leave counts as not told. The record stays, marked void."
          summary={[
            { label: "CS", value: nameOf(voiding.user_id) },
            {
              label: "Days",
              value: `${sheetDay(voiding.from_day)}${voiding.to_day !== voiding.from_day ? ` – ${sheetDay(voiding.to_day)}` : ""} (${leaveDays(voiding)})`,
            },
            { label: LEAVE_KIND_LABEL[voiding.kind], value: voiding.reason, emphasis: true },
          ]}
          confirmLabel="Void leave"
          tone="danger"
          onConfirm={async () => {
            const res = await send(`/api/staff-leaves/${voiding.leave_id}`, "DELETE");
            if (!res.ok) return void toast.error(res.error);
            toast.success("Leave voided");
            setSelectedIds([]);
            await reload();
          }}
        />
      )}
    </>
  );
}

"use client";

/**
 * The Staff Penalty worksheet tab: credit lost through a CS's mistake and the
 * share they bear. Typed into the NEW ENTRIES dock like any other sheet —
 * name the deposit, free credit or withdrawal by its ref and the CS and what was credited
 * fill in; Lost and Penalty work themselves out. Deducted by their next salary
 * without anyone ticking it — the Status column says which salary took it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Ban, Loader2, RefreshCw, Save, X } from "lucide-react";
import { SheetGrid, type SheetColumn, type SheetRow } from "@/components/sheet/sheet-grid";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  fmtAmount,
  parseAmount,
  parseSheetDate,
  todaySheetDate,
  useEntryDock,
  type Parsed,
} from "./entry-dock";
import { CsProfileButton, CsProfileModal, useCsProfileShortcut } from "./cs-profile-modal";
import {
  currentMonth,
  monthLabel,
  PENALTY_SOURCE_LABEL,
  send,
  useStaffPay,
  type PenaltySource,
  type StaffPenalty,
  type StaffRow,
} from "./use-staff-pay";

const noop = () => {};
const noDraftStatus = () => ({ state: "empty" as const });
const MOD_LABEL = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const round2 = (n: number) => Math.round(n * 100) / 100;

const STATUS_PILLS: Array<[string, string]> = [
  ["pending", "Pending"],
  ["deducted", "Deducted"],
  ["void", "Void"],
];

// Columns, saved rows and the dock alike.
const C = { date: 0, cs: 1, casino: 2, source: 3, ref: 4, injected: 5, retrieved: 6, lost: 7, share: 8, amount: 9, reason: 10, status: 11, by: 12 } as const;
const N_COLS = 13;

const SOURCES = Object.entries(PENALTY_SOURCE_LABEL) as Array<[PenaltySource, string]>;
const LOOKS_UP = (s: PenaltySource | null) => s === "deposit" || s === "free_credit" || s === "withdrawal";
/** A withdrawal paid out wrong is the CS's whole loss, not the house share. */
const WITHDRAWAL_SHARE = "100%";

type SourceLookup = {
  user_id: number | null;
  credit_injected: number;
  player_id: number | null;
  player_label: string | null;
  occurred_at: string;
  /** The deposit's or withdrawal's status; null for a free credit. */
  status: string | null;
};
type LookupEntry = { source: SourceLookup } | { error: string };

function parseSource(cell: string): PenaltySource | null {
  const v = cell.trim().toLowerCase().replace(/[\s_]+/g, " ");
  if (!v) return null;
  return SOURCES.find(([k, label]) => label.toLowerCase() === v || k.replace("_", " ") === v)?.[0] ?? null;
}

/** "12" or "#12" → 12. */
const parseRef = (cell: string) => {
  const m = cell.trim().match(/^#?(\d+)$/);
  return m ? Number(m[1]) : null;
};

/** Credited, retrieved and share off a row; Lost and Penalty from them. */
const figures = (row: string[]) => {
  const inj = parseAmount(row[C.injected] ?? "");
  const ret = parseAmount(row[C.retrieved] ?? "") ?? 0;
  const pct = parseAmount((row[C.share] ?? "").replace("%", ""));
  if (inj === null || inj <= 0 || pct === null) return null;
  const lost = round2(inj - ret);
  return { inj, ret, pct, lost, amount: round2((lost * pct) / 100) };
};

/** An ISO time → the sheet's date, business time — "19/10/2026". */
function sheetDateOf(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
}

/** A row on another sheet to record a penalty against — pre-fills the dock. */
export type PenaltyPrefill = { source: "deposit" | "free_credit" | "withdrawal"; ref: number; nonce: number };

export function PenaltySheet({ prefill = null }: { prefill?: PenaltyPrefill | null } = {}) {
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);
  const entityName = useStore((s) => s.entityName);
  const companyInScope = useStore((s) => s.companyInScope);
  const isViewer = me?.role === "viewer";
  const canVoid = me?.role === "super_admin" || me?.role === "company_leader";
  // A CS can't record one against themselves (the server refuses it too).
  const selfId = me?.role === "cs_agent" ? me.user_id : null;

  // The month only matters to the staff list; penalties are listed whole.
  const { data, loading, error, reload } = useStaffPay(currentMonth());
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(() => new Set());
  const [voiding, setVoiding] = useState<StaffPenalty | null>(null);
  const [selectedDrafts, setSelectedDrafts] = useState<number[]>([]);
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
  const sharePct = data?.share_pct ?? 50;

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

  // ---- the row a mistake was made on, looked up by its ref ----

  const [lookups, setLookups] = useState<Map<string, LookupEntry>>(new Map());
  const lookupKey = (source: PenaltySource, id: number) => `${source}:${id}`;
  const lookupOf = useCallback(
    (row: string[]) => {
      const source = parseSource(row[C.source] ?? "");
      const ref = parseRef(row[C.ref] ?? "");
      if (!LOOKS_UP(source) || !ref) return { wanted: false as const };
      const key = lookupKey(source!, ref);
      return { wanted: true as const, key, source: source!, ref, entry: lookups.get(key) };
    },
    [lookups],
  );

  // ---- the dock ----

  const autoCells = useCallback(
    (): Array<[number, string]> => [
      [C.date, todaySheetDate()],
      [C.source, PENALTY_SOURCE_LABEL.deposit],
      [C.retrieved, "0"],
      [C.share, `${sharePct}%`],
    ],
    [sharePct],
  );

  const derive = useCallback(
    (rows: string[][]) =>
      rows.map((row) => {
        const next = [...row];
        for (const c of [C.casino, C.lost, C.amount, C.status, C.by]) next[c] = "";
        const cs = resolveCs(row[C.cs] ?? "");
        if (cs) next[C.casino] = entityName(cs.company_entity_id);
        const f = figures(row);
        if (f && f.lost > 0) {
          next[C.lost] = fmtAmount(f.lost);
          next[C.amount] = fmtAmount(f.amount);
        }
        const l = lookupOf(row);
        if (l.wanted && !l.entry) next[C.status] = "Looking it up…";
        else if (l.wanted && l.entry && "source" in l.entry && l.entry.source.player_label) {
          // Saving fails a completed deposit (the money never came) — say so first.
          const fails = l.source === "deposit" && l.entry.source.status === "completed";
          const unpaid = l.source === "withdrawal" && l.entry.source.status !== "paid";
          const note = fails ? " · deposit will be failed" : unpaid ? ` · withdrawal is ${l.entry.source.status}, not paid` : "";
          next[C.status] = `Player ${l.entry.source.player_label}${note}`;
        } else if (cs) next[C.status] = "Pending — next salary";
        return next;
      }),
    [resolveCs, entityName, lookupOf],
  );

  type Body = {
    user_id: number;
    source_type: PenaltySource;
    source_id: number | null;
    player_id: number | null;
    occurred_at: string;
    credit_injected: number;
    credit_retrieved: number;
    share_pct: number;
    reason: string;
  };
  const parse = useCallback(
    (row: string[]): Parsed<Body> | null => {
      const date = parseSheetDate(row[C.date] ?? "");
      if (!date) return { ok: false, error: `Bad date "${(row[C.date] ?? "").trim()}" (use 31/8/2026)` };
      const source = parseSource(row[C.source] ?? "");
      if (!source) {
        return { ok: false, error: `Mistake On is one of ${SOURCES.map(([, l]) => l).join(", ")}` };
      }
      const refCell = (row[C.ref] ?? "").trim();
      const ref = refCell ? parseRef(refCell) : null;
      if (refCell && !ref) return { ok: false, error: `Ref is the row's number, like 1234 — not "${refCell}"` };
      if (LOOKS_UP(source) && !ref) return { ok: false, error: `Ref — the ${PENALTY_SOURCE_LABEL[source].toLowerCase()} number` };
      const l = lookupOf(row);
      if (l.wanted && !l.entry) return null;
      if (l.wanted && l.entry && "error" in l.entry) return { ok: false, error: l.entry.error };

      const csCell = (row[C.cs] ?? "").trim();
      if (!csCell) return { ok: false, error: "Who — pick the CS" };
      const cs = resolveCs(csCell);
      if (!cs) {
        const isSelf = selfId != null && staff.some((s) => s.user_id === selfId && [s.full_name, s.username].some((n) => n.toLowerCase() === csCell.toLowerCase()));
        return { ok: false, error: isSelf ? "Ask a colleague or your leader to record a penalty against you" : `No CS called "${csCell}" — pick from the list` };
      }
      const f = figures(row);
      if (!f) {
        if (parseAmount((row[C.share] ?? "").replace("%", "")) === null) return { ok: false, error: "Share — a percent, like 50%" };
        return { ok: false, error: "Credited — what went into the player's account, or what a withdrawal paid out" };
      }
      if (f.ret < 0 || f.ret >= f.inj) return { ok: false, error: "Retrieved has to be less than what was credited" };
      if (f.pct < 0 || f.pct > 100) return { ok: false, error: "Share is a percent, 0–100" };
      const reason = (row[C.reason] ?? "").trim();
      if (!reason) return { ok: false, error: "What Happened — a line on the mistake" };
      if (f.amount <= 0) return { ok: false, error: "That works out to RM 0 — nothing to deduct" };
      return {
        ok: true,
        body: {
          user_id: cs.user_id,
          source_type: source,
          source_id: ref,
          player_id: l.wanted && l.entry && "source" in l.entry ? l.entry.source.player_id : null,
          occurred_at: `${date}T12:00:00+08:00`,
          credit_injected: f.inj,
          credit_retrieved: f.ret,
          share_pct: f.pct,
          reason,
        },
      };
    },
    [lookupOf, resolveCs, selfId, staff],
  );

  const dock = useEntryDock<Body>({
    nCols: N_COLS,
    autoCells,
    derive,
    parse,
    submit: async (body) => {
      const res = await send("/api/staff-penalties", "POST", body);
      return res.ok ? { ok: true } : res;
    },
    noun: (n) => (n === 1 ? "penalty" : "penalties"),
    onSaved: () => reload(),
    enabled: !isViewer,
  });

  // Sent here by "Staff error" on a Deposit / Free Credit row: start a row
  // naming it, and the lookup below fills in the CS, the credit and the date.
  const { drafts, patchRow, addRow } = dock;
  const prefilled = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || isViewer || prefilled.current === prefill.nonce) return;
    prefilled.current = prefill.nonce;
    const named = drafts.some(
      (row) => parseSource(row[C.source] ?? "") === prefill.source && parseRef(row[C.ref] ?? "") === prefill.ref,
    );
    if (!named) {
      addRow([
        [C.source, PENALTY_SOURCE_LABEL[prefill.source]],
        [C.ref, String(prefill.ref)],
        ...(prefill.source === "withdrawal" ? [[C.share, WITHDRAWAL_SHARE] as [number, string]] : []),
      ]);
    }
  }, [prefill, isViewer, drafts, addRow]);

  // Look up every ref the dock names that we haven't; fill the blanks it can.
  useEffect(() => {
    const wanted = new Map<string, { source: PenaltySource; ref: number }>();
    for (const row of drafts) {
      const l = lookupOf(row);
      if (l.wanted && !l.entry) wanted.set(l.key, { source: l.source, ref: l.ref });
    }
    if (!wanted.size) return;
    let live = true;
    void Promise.all(
      [...wanted.entries()].map(async ([key, w]): Promise<[string, LookupEntry]> => {
        try {
          const res = await fetch(`/api/staff-penalties/source?type=${w.source}&id=${w.ref}`);
          const d = (await res.json().catch(() => null)) as { source?: SourceLookup; error?: string } | null;
          return [key, res.ok && d?.source ? { source: d.source } : { error: d?.error ?? "Not found" }];
        } catch {
          return [key, { error: "Network error" }];
        }
      }),
    ).then((entries) => {
      if (!live) return;
      setLookups((prev) => {
        const next = new Map(prev);
        for (const [k, v] of entries) next.set(k, v);
        return next;
      });
      for (const [key, entry] of entries) {
        if (!("source" in entry)) continue;
        const src = entry.source;
        patchRow(
          (row) => {
            const source = parseSource(row[C.source] ?? "");
            const ref = parseRef(row[C.ref] ?? "");
            return !!source && !!ref && lookupKey(source, ref) === key;
          },
          (row) => {
            const next = [...row];
            if (!next[C.injected].trim()) next[C.injected] = String(src.credit_injected);
            if (next[C.date] === todaySheetDate()) next[C.date] = sheetDateOf(src.occurred_at);
            // Still on the house share the dock started it with → the CS's whole loss.
            if (key.startsWith("withdrawal:") && next[C.share].trim() === `${sharePct}%`) next[C.share] = WITHDRAWAL_SHARE;
            return next;
          },
        );
      }
    });
    return () => {
      live = false;
    };
  }, [drafts, lookupOf, patchRow, sharePct]);

  /**
   * The CS who keyed the row, once both the lookup and the staff list are in.
   * Apart from the lookup above because they race: opened from "Staff error",
   * the lookup usually lands before the staff list does. Once per row, so a
   * CS cleared on purpose stays cleared.
   */
  const csFilled = useRef(new Set<string>());
  useEffect(() => {
    for (const row of drafts) {
      const l = lookupOf(row);
      if (!l.wanted || !l.entry || !("source" in l.entry) || csFilled.current.has(l.key)) continue;
      const userId = l.entry.source.user_id;
      const handler = userId != null ? pickable.find((s) => s.user_id === userId) : undefined;
      if (!handler) continue;
      csFilled.current.add(l.key);
      const key = l.key;
      patchRow(
        (r) => {
          const lr = lookupOf(r);
          return lr.wanted && lr.key === key;
        },
        (r) => (r[C.cs].trim() ? r : r.map((v, c) => (c === C.cs ? handler.full_name : v))),
      );
    }
  }, [drafts, lookupOf, patchRow, pickable]);

  // ---- the sheet ----

  const columns: SheetColumn[] = [
    { key: "date", label: "Date", width: 92, align: "center", entry: true, required: true, placeholder: todaySheetDate() },
    { key: "cs", label: "CS", width: 160, entry: true, required: true, options: csOptions, placeholder: "fills from Ref" },
    { key: "casino", label: "Casino", width: 130 },
    { key: "source", label: "Mistake On", width: 110, entry: true, required: true, options: SOURCES.map(([, l]) => l) },
    { key: "ref", label: "Ref", width: 70, align: "right", entry: true, placeholder: "#" },
    { key: "injected", label: "Credited", width: 96, align: "right", numeric: true, entry: true, required: true, placeholder: "fills from Ref" },
    { key: "retrieved", label: "Retrieved", width: 96, align: "right", numeric: true, entry: true },
    { key: "lost", label: "Lost", width: 90, align: "right", numeric: true },
    { key: "share", label: "Share", width: 64, align: "right", entry: true },
    { key: "amount", label: "Penalty", width: 96, align: "right", numeric: true },
    { key: "reason", label: "What Happened", width: 260, entry: true, required: true, placeholder: "the mistake" },
    { key: "status", label: "Status", width: 150 },
    { key: "by", label: "Recorded By", width: 120 },
  ];

  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (data?.penalties ?? [])
        .filter((p) => companyInScope(p.company_entity_id))
        .filter((p) => statusFilter.size === 0 || statusFilter.has(statusOf(p)))
        .slice()
        .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
        .map((p): SheetRow => {
          const st = statusOf(p);
          const cells = Array<string>(N_COLS).fill("");
          cells[C.date] = sheetDateOf(p.occurred_at);
          cells[C.cs] = nameOf(p.user_id);
          cells[C.casino] = entityName(p.company_entity_id);
          cells[C.source] = PENALTY_SOURCE_LABEL[p.source_type];
          cells[C.ref] = p.source_id ? `#${p.source_id}` : "";
          cells[C.injected] = fmtAmount(p.credit_injected);
          cells[C.retrieved] = fmtAmount(p.credit_retrieved);
          cells[C.lost] = fmtAmount(p.loss_amount);
          cells[C.share] = `${p.share_pct}%`;
          cells[C.amount] = fmtAmount(p.amount);
          cells[C.reason] = p.reason;
          cells[C.status] =
            st === "void"
              ? "Void"
              : st === "deducted"
                ? `Deducted · ${monthLabel(deductedIn.get(p.penalty_id) ?? "")} salary`
                : "Pending — next salary";
          cells[C.by] = nameOf(p.recorded_by_user_id);
          return { id: p.penalty_id, tone: st === "void" ? "muted" : st === "deducted" ? "default" : "warning", cells };
        })
        .filter((r) => !q || r.cells.some((c) => c.toLowerCase().includes(q))),
    [data, companyInScope, statusFilter, statusOf, nameOf, entityName, deductedIn, q],
  );

  // The CS behind the selection, saved rows and NEW ENTRIES rows alike —
  // only when it's one person.
  const selectedCs = useMemo(() => {
    const ids = new Set<number>();
    for (const id of selectedIds) {
      const uid = data?.penalties.find((p) => p.penalty_id === Number(id))?.user_id;
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
          key="penalty"
          widthStorageKey="transactions:penalty"
          columns={columns}
          rows={rows}
          drafts={isViewer ? [] : dock.drafts}
          onDraftsChange={isViewer ? noop : dock.onDraftsChange}
          draftStatus={isViewer ? noDraftStatus : dock.draftStatus}
          flushRef={isViewer ? undefined : dock.flushRef}
          readOnly={isViewer}
          onSelectedRowsChange={setSelectedIds}
          onSelectedDraftsChange={setSelectedDrafts}
          focusKey={`penalty:${!!data}`}
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
        initialSection="penalties"
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

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useStore } from "@/lib/store";
import type { AuditEntry } from "@/lib/types";
import { formatRM, formatDateTime } from "@/lib/format";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlayerNameLink } from "@/components/player-name-link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  Filter,
  ScrollText,
  Download,
  Loader2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

type AuditType = AuditEntry["type"];

type HistoryEntry = {
  transaction_id: number;
  type: AuditType;
  player_id: number | null;
  amount: number;
  game_name: string | null;
  reference_id: number | null;
  details: Record<string, unknown> | null;
  user_id: number | null;
  created_at: string;
  player_full_name: string | null;
  player_username: string | null;
  user_name: string | null;
};

const TYPE_META: Record<AuditType, { label: string; className: string }> = {
  deposit: { label: "Deposit", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  withdrawal: { label: "Withdrawal", className: "bg-blue-500/10 text-blue-700 dark:text-blue-300" },
  game_topup: { label: "Game Top-up", className: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  game_transfer: {
    label: "Game Transfer",
    className: "bg-purple-500/10 text-purple-700",
  },
  credit_pull: {
    label: "Credit Pull",
    className: "bg-indigo-500/10 text-indigo-700",
  },
  bank_transfer: {
    label: "Bank Transfer",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  bo_adjustment: {
    label: "BO Adjustment",
    className: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
  player_import: {
    label: "Player Import",
    className: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  },
  recommend_bonus: {
    label: "Recommend Bonus",
    className: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  },
  leader_transfer: {
    label: "Leader Transfer",
    className: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  },
};

/**
 * Never index TYPE_META directly on a row's type. The ledger can carry a type
 * this build doesn't know about — a migration that adds an enum value lands
 * before the deploy that teaches the UI about it — and an undefined lookup here
 * takes the whole page down over one unrecognised row.
 */
function typeMeta(type: string): { label: string; className: string } {
  return (
    TYPE_META[type as AuditType] ?? {
      label: type.replace(/_/g, " "),
      className: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
    }
  );
}

const TYPE_ORDER: AuditType[] = [
  "deposit",
  "withdrawal",
  "game_topup",
  "recommend_bonus",
  "game_transfer",
  "credit_pull",
  "bank_transfer",
  "bo_adjustment",
  "player_import",
  "leader_transfer",
];

const AMOUNTLESS_TYPES = new Set<AuditType>(["player_import"]);

function referenceOf(e: {
  details: Record<string, unknown> | null;
  reference_id: number | null;
}): string {
  const d = e.details ?? {};
  const candidate =
    d["topup_reference"] ?? d["reference"] ?? d["transaction_ref"];
  if (typeof candidate === "string" && candidate) return candidate;
  if (typeof candidate === "number") return String(candidate);
  if (e.reference_id != null) return `#${e.reference_id}`;
  return "—";
}

const REFERENCE_KEYS = new Set(["topup_reference", "reference", "transaction_ref"]);

function detailsSummary(e: { details: Record<string, unknown> | null }): string {
  const d = e.details ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (REFERENCE_KEYS.has(k)) continue;
    if (v == null || typeof v === "object") continue;
    parts.push(`${k.replaceAll("_", " ")}: ${v}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" · ") || "—";
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const PAGE_SIZE = 50;
const EXPORT_CAP = 5000;

export default function HistoryPage() {
  const users = useStore((s) => s.users);
  const companiesFn = useStore((s) => s.companies);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);

  // A set, not a single value: empty means "no filter" (all types), which keeps
  // the default cheap to express and the URL free of a nine-item list.
  const [types, setTypes] = useState<Set<AuditType>>(new Set());
  const [handledBy, setHandledBy] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [q, setQ] = useState("");

  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const activeCompany = companiesFn().find(
    (c) => c.company_id === selectedCompanyId,
  );

  const hasFilters =
    types.size > 0 ||
    handledBy !== "all" ||
    !!dateFrom ||
    !!dateTo ||
    !!q.trim();

  function buildParams(off: number, limit: number) {
    const p = new URLSearchParams();
    p.set("limit", String(limit));
    p.set("offset", String(off));
    // Omitted entirely when nothing is ticked, so "all" stays the absence of a
    // filter rather than a value the server has to special-case.
    if (types.size) p.set("type", [...types].join(","));
    if (handledBy !== "all") p.set("user", handledBy);
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    if (q.trim()) p.set("q", q.trim());
    if (selectedCompanyId != null) p.set("company_id", String(selectedCompanyId));
    if (selectedLeaderId != null) p.set("leader_id", String(selectedLeaderId));
    return p;
  }

  // Reset to the first page whenever a filter (or the top-nav scope) changes.
  const filterKey = JSON.stringify([
    // Sorted, so ticking A then B and B then A are the same filter and don't
    // trigger a redundant refetch.
    [...types].sort(),
    handledBy,
    dateFrom,
    dateTo,
    q.trim(),
    selectedCompanyId,
    selectedLeaderId,
  ]);
  const [prevKey, setPrevKey] = useState(filterKey);
  if (filterKey !== prevKey) {
    setPrevKey(filterKey);
    setOffset(0);
  }

  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      fetch(`/api/history?${buildParams(offset, PAGE_SIZE)}`, {
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((data) => {
          setEntries(data.entries ?? []);
          setTotal(data.total ?? 0);
          setTotalAmount(data.totalAmount ?? 0);
        })
        .catch(() => {})
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterKey,
    handledBy,
    dateFrom,
    dateTo,
    q,
    offset,
    selectedCompanyId,
    selectedLeaderId,
  ]);

  function setPreset(days: number | null) {
    if (days === null) {
      setDateFrom("");
      setDateTo("");
    } else {
      setDateFrom(daysAgoStr(days));
      setDateTo(todayStr());
    }
  }

  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const all: HistoryEntry[] = [];
      let off = 0;
      while (all.length < EXPORT_CAP) {
        const res = await fetch(`/api/history?${buildParams(off, 200)}`);
        const data = await res.json();
        const batch: HistoryEntry[] = data.entries ?? [];
        all.push(...batch);
        if (batch.length < 200 || all.length >= (data.total ?? 0)) break;
        off += 200;
      }
      const header = [
        "Date",
        "Type",
        "Player",
        "Amount",
        "Game",
        "By",
        "Reference",
        "Details",
      ];
      const rows = all.map((e) => [
        e.created_at.slice(0, 19).replace("T", " "),
        typeMeta(e.type).label,
        e.player_full_name
          ? `${e.player_full_name} (@${e.player_username})`
          : "",
        AMOUNTLESS_TYPES.has(e.type) && e.amount === 0 ? "" : e.amount.toFixed(2),
        e.game_name ?? "",
        e.user_name ?? (e.user_id == null ? "System" : ""),
        referenceOf(e),
        detailsSummary(e),
      ]);
      const esc = (v: string) =>
        /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      const csv = [header, ...rows]
        .map((r) => r.map((c) => esc(String(c))).join(","))
        .join("\n");
      const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transaction-history-${todayStr()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(
        `Exported ${all.length} records${all.length >= EXPORT_CAP ? " (capped)" : ""}`,
      );
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(false);
    }
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = offset + entries.length;
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Transaction History</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Full server-side audit trail of every money and credit movement
          {activeCompany && (
            <>
              {" "}
              ·{" "}
              <span className="font-medium text-foreground">
                {activeCompany.company_name}
              </span>
            </>
          )}
        </p>
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          {/* Multi-select: the trigger keeps the Select's shape and width so it
              still reads as one of the filter row's controls, but the menu ticks
              rather than replaces. Nothing ticked = every type, which is why the
              label falls back to "All types" instead of "None". */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(props) => (
                <button
                  {...props}
                  className="flex h-8 w-[170px] items-center justify-between gap-1.5 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 cursor-pointer"
                >
                  <span className="truncate">
                    {types.size === 0
                      ? "All types"
                      : types.size === 1
                        ? TYPE_META[[...types][0]].label
                        : `${types.size} types`}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              )}
            />
            <DropdownMenuContent align="start" className="w-[190px]">
              <DropdownMenuItem
                onClick={() => setTypes(new Set())}
                className="cursor-pointer"
              >
                All types
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {TYPE_ORDER.map((t) => (
                <DropdownMenuCheckboxItem
                  key={t}
                  checked={types.has(t)}
                  // Kept open on click: picking several types one at a time is
                  // the whole point, and a menu that shuts after each tick
                  // makes that four round trips instead of one.
                  closeOnClick={false}
                  onCheckedChange={(checked) =>
                    setTypes((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(t);
                      else next.delete(t);
                      return next;
                    })
                  }
                  className="cursor-pointer"
                >
                  {TYPE_META[t].label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Select
            value={handledBy}
            onValueChange={(v) => setHandledBy(v ?? "all")}
            items={[
              { value: "all", label: "Anyone" },
              { value: "system", label: "System / agent" },
              ...users.map((u) => ({
                value: String(u.user_id),
                label: u.full_name,
              })),
            ]}
          >
            <SelectTrigger className="h-8 w-[150px]">
              <SelectValue placeholder="Handled by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Anyone</SelectItem>
              <SelectItem value="system">System / agent</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.user_id} value={String(u.user_id)}>
                  {u.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 w-[140px]"
              aria-label="From date"
            />
            <span className="text-[11px] text-muted-foreground">to</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-8 w-[140px]"
              aria-label="To date"
            />
          </div>
          <div className="flex gap-1">
            {(
              [
                ["Today", 0],
                ["7D", 7],
                ["30D", 30],
                ["All", null],
              ] as const
            ).map(([label, days]) => (
              <button
                key={label}
                onClick={() => setPreset(days)}
                className="h-7 cursor-pointer rounded-md border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative min-w-[180px] flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search player, reference…"
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={total === 0 || exporting}
            className="cursor-pointer"
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Export
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2 text-[11px] text-muted-foreground">
          <span>
            {total.toLocaleString()} record{total === 1 ? "" : "s"}
            {hasFilters && " (filtered)"} ·{" "}
            <span className="font-medium text-foreground">
              {formatRM(totalAmount)}
            </span>{" "}
            moved
          </span>
          <span className="inline-flex items-center gap-1">
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
            {total > 0 && (
              <span>
                {pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of{" "}
                {total.toLocaleString()}
              </span>
            )}
          </span>
        </div>

        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-14 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {loading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <ScrollText className="h-5 w-5" />
              )}
            </div>
            <p className="text-sm font-medium">
              {loading
                ? "Loading…"
                : hasFilters
                  ? "No records match your filters"
                  : "No activity recorded yet"}
            </p>
            {!loading && (
              <p className="text-[12px] text-muted-foreground max-w-sm">
                {hasFilters
                  ? "Try widening the date range or clearing a filter."
                  : "Deposits, withdrawals, transfers and adjustments will appear here as they happen."}
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Date</th>
                  <th className="px-3 py-2.5 text-left font-medium">Type</th>
                  <th className="px-3 py-2.5 text-left font-medium">Player</th>
                  <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Amount</th>
                  <th className="px-3 py-2.5 text-left font-medium">Game</th>
                  <th className="px-3 py-2.5 text-left font-medium">By</th>
                  <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Reference</th>
                  <th className="px-3 py-2.5 text-left font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const meta = typeMeta(e.type);
                  const signed = e.type === "bo_adjustment";
                  return (
                    <tr
                      key={e.transaction_id}
                      className="border-t hover:bg-muted/30"
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-[12px]">
                        {formatDateTime(e.created_at)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${meta.className}`}
                        >
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {e.player_id != null ? (
                          <PlayerNameLink playerId={e.player_id}>
                            {e.player_username ?? `P-${e.player_id}`}
                          </PlayerNameLink>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-medium whitespace-nowrap ${
                          signed
                            ? e.amount >= 0
                              ? "text-emerald-700 dark:text-emerald-300"
                              : "text-rose-700 dark:text-rose-300"
                            : ""
                        }`}
                      >
                        {AMOUNTLESS_TYPES.has(e.type) && e.amount === 0
                          ? "—"
                          : signed
                            ? `${e.amount >= 0 ? "+" : "−"}${formatRM(Math.abs(e.amount))}`
                            : formatRM(e.amount)}
                      </td>
                      <td className="px-3 py-2 text-[12px]">
                        {e.game_name ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-muted-foreground">
                        {e.user_name ?? (e.user_id == null ? "System" : "—")}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                        {referenceOf(e)}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-muted-foreground max-w-[260px] truncate">
                        {detailsSummary(e)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t px-4 py-2.5">
            <span className="text-[11px] text-muted-foreground">
              Page {Math.floor(offset / PAGE_SIZE) + 1} of{" "}
              {Math.ceil(total / PAGE_SIZE)}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                disabled={!canPrev || loading}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                className="cursor-pointer"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canNext || loading}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                className="cursor-pointer"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

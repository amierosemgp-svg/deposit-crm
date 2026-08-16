"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Filter,
  Loader2,
  ScrollText,
  Search,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
const EXPORT_CAP = 5000;

type LogSource = "activity" | "money" | "agent";

type LogEntry = {
  source: LogSource;
  id: number;
  occurred_at: string;
  category: string;
  action: string;
  summary: string | null;
  actor_user_id: number | null;
  actor_label: string | null;
  company_entity_id: number | null;
  company_name: string | null;
  target_label: string | null;
  amount: number | null;
  details: Record<string, unknown> | null;
};

type FieldChange = { field: string; from: unknown; to: unknown };

const SOURCE_META: Record<LogSource, { label: string; className: string }> = {
  activity: {
    label: "Config",
    className: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
  },
  money: {
    label: "Money",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  agent: {
    label: "Agent",
    className: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  },
};

/** Categories, grouped by the source they come from. */
const CATEGORY_GROUPS: { label: string; source: LogSource; values: string[] }[] = [
  {
    label: "Administration",
    source: "activity",
    values: [
      "auth",
      "user",
      "entity",
      "player",
      "bank_account",
      "kiosk",
      "bonus",
      "api_key",
      "settings",
      "expense",
      "other",
    ],
  },
  {
    label: "Money",
    source: "money",
    values: [
      "deposit",
      "withdrawal",
      "game_topup",
      "game_transfer",
      "credit_pull",
      "bank_transfer",
      "bo_adjustment",
      "player_import",
      "recommend_bonus",
    ],
  },
  {
    label: "Agent",
    source: "agent",
    values: ["debug", "info", "warn", "error"],
  },
];

function titleCase(value: string): string {
  return value
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Postgres hands back "2026-08-16 17:47:11.33+08"; the T makes it parseable. */
function when(iso: string): { date: string; time: string } {
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
  const day = String(d.getDate()).padStart(2, "0");
  const month = d.toLocaleString("en-US", { month: "short" });
  return {
    date: `${day} ${month}`,
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`,
  };
}

/**
 * The one-line "what happened".
 *
 * Config rows were written with their sentence already composed. Money and
 * agent rows weren't — those tables predate this page — so the line is built
 * from what they do carry.
 */
function headline(e: LogEntry): string {
  if (e.summary) return e.summary;
  if (e.source === "money") {
    const what = titleCase(e.action === e.category ? e.category : e.action);
    return e.target_label ? `${what} — @${e.target_label}` : what;
  }
  return titleCase(e.action);
}

function changesOf(e: LogEntry): FieldChange[] {
  const raw = e.details?.changes;
  return Array.isArray(raw) ? (raw as FieldChange[]) : [];
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Every recorded action, from all three places the system keeps them.
 *
 * Administration lands in activity_log, money in transactions, the agent in
 * bot_events; the API unions them at read time so this page can ask "what
 * happened at 3pm" once instead of three times.
 */
export default function SystemLogPage() {
  const me = useStore((s) => s.me);
  const users = useStore((s) => s.users);

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [source, setSource] = useState("all");
  const [category, setCategory] = useState("all");
  const [actor, setActor] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [q, setQ] = useState("");

  const allowed = me?.role === "super_admin" || me?.role === "company_leader";

  function buildParams(off: number, lim: number) {
    const p = new URLSearchParams({ limit: String(lim), offset: String(off) });
    if (source !== "all") p.set("source", source);
    if (category !== "all") p.set("category", category);
    if (actor !== "all") p.set("user", actor);
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    if (q.trim()) p.set("q", q.trim());
    return p;
  }

  // Any filter change puts you back on page one — paging into an offset that
  // no longer exists is the classic "my results vanished" bug.
  const filterKey = JSON.stringify([source, category, actor, dateFrom, dateTo, q.trim()]);
  const [prevKey, setPrevKey] = useState(filterKey);
  if (filterKey !== prevKey) {
    setPrevKey(filterKey);
    setOffset(0);
  }

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      fetch(`/api/system-log?${buildParams(offset, PAGE_SIZE)}`, {
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((data) => {
          setEntries(data.entries ?? []);
          setTotal(data.total ?? 0);
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
  }, [source, category, actor, dateFrom, dateTo, q, offset, allowed]);

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
      const all: LogEntry[] = [];
      let off = 0;
      while (all.length < EXPORT_CAP) {
        const res = await fetch(`/api/system-log?${buildParams(off, 200)}`);
        const data = await res.json();
        const batch: LogEntry[] = data.entries ?? [];
        all.push(...batch);
        if (batch.length < 200 || all.length >= (data.total ?? 0)) break;
        off += 200;
      }
      const header = [
        "Time",
        "Source",
        "Category",
        "Action",
        "Who",
        "What",
        "Company",
        "Amount",
        "Changes",
      ];
      const rows = all.map((e) => [
        e.occurred_at.slice(0, 19).replace("T", " "),
        SOURCE_META[e.source].label,
        e.category,
        e.action,
        e.actor_label ?? "System",
        headline(e),
        e.company_name ?? "",
        e.amount === null ? "" : e.amount.toFixed(2),
        changesOf(e)
          .map((c) => `${c.field}: ${formatValue(c.from)} → ${formatValue(c.to)}`)
          .join("; "),
      ]);
      const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const csv = [header, ...rows]
        .map((r) => r.map((c) => esc(String(c))).join(","))
        .join("\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `system-log-${todayStr()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(
        `Exported ${all.length} entries${all.length >= EXPORT_CAP ? " (capped)" : ""}`,
      );
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(false);
    }
  }

  if (me && !allowed) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">System Log</h1>
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Only leaders and admins can read the system log.
        </Card>
      </div>
    );
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = offset + entries.length;
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">System Log</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every recorded action — configuration, money, sign-ins, and the agent —
          in one trail
        </p>
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />

          <Select
            value={source}
            onValueChange={(v) => setSource(v ?? "all")}
            items={[
              { value: "all", label: "All sources" },
              { value: "activity", label: "Config & auth" },
              { value: "money", label: "Money" },
              { value: "agent", label: "Agent" },
            ]}
          >
            <SelectTrigger className="h-8 w-[140px] cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="activity">Config &amp; auth</SelectItem>
              <SelectItem value="money">Money</SelectItem>
              <SelectItem value="agent">Agent</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={category}
            onValueChange={(v) => setCategory(v ?? "all")}
            items={[
              { value: "all", label: "All categories" },
              ...CATEGORY_GROUPS.flatMap((g) =>
                g.values.map((v) => ({ value: v, label: titleCase(v) })),
              ),
            ]}
          >
            <SelectTrigger className="h-8 w-[160px] cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CATEGORY_GROUPS.filter(
                (g) => source === "all" || source === g.source,
              ).map((g) => (
                <SelectGroup key={g.label}>
                  <SelectLabel>{g.label}</SelectLabel>
                  {g.values.map((v) => (
                    <SelectItem key={v} value={v}>
                      {titleCase(v)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={actor}
            onValueChange={(v) => setActor(v ?? "all")}
            items={[
              { value: "all", label: "Anyone" },
              { value: "system", label: "System / agent" },
              ...users.map((u) => ({ value: String(u.user_id), label: u.full_name })),
            ]}
          >
            <SelectTrigger className="h-8 w-[150px] cursor-pointer">
              <SelectValue />
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
              placeholder="Search action, person, target…"
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

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/10 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">What happened</th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="w-8 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {loading && entries.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                  </td>
                </tr>
              )}

              {!loading && entries.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center">
                    <ScrollText className="mx-auto h-6 w-6 text-muted-foreground" />
                    <p className="mt-2 text-sm font-medium">Nothing recorded</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      No action matches these filters.
                    </p>
                  </td>
                </tr>
              )}

              {entries.map((e) => {
                const key = `${e.source}-${e.id}`;
                const changes = changesOf(e);
                const context = e.details?.context as
                  | Record<string, unknown>
                  | undefined;
                const expandable =
                  changes.length > 0 ||
                  (!!context && Object.keys(context).length > 0) ||
                  (e.source === "money" && !!e.details);
                const isOpen = expanded === key;
                const stamp = when(e.occurred_at);

                return (
                  <tr
                    key={key}
                    className={cn(
                      "border-b align-top last:border-b-0",
                      isOpen && "bg-muted/20",
                    )}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-[12px] font-medium">{stamp.date}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {stamp.time}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium",
                          SOURCE_META[e.source].className,
                        )}
                      >
                        {SOURCE_META[e.source].label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[12px] whitespace-nowrap">
                      {titleCase(e.category)}
                    </td>
                    <td className="px-3 py-2 text-[12px] whitespace-nowrap">
                      {e.actor_label ?? (
                        <span className="text-muted-foreground">System</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-[13px] leading-snug">{headline(e)}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {e.action}
                      </div>
                      {isOpen && (
                        <div className="mt-2 space-y-2 rounded-md border bg-background p-2.5">
                          {changes.length > 0 && (
                            <div className="space-y-1">
                              {changes.map((c) => (
                                <div
                                  key={c.field}
                                  className="flex flex-wrap items-baseline gap-1.5 text-[11px]"
                                >
                                  <span className="font-medium">{c.field}</span>
                                  <span className="text-muted-foreground line-through">
                                    {formatValue(c.from)}
                                  </span>
                                  <span className="text-muted-foreground">→</span>
                                  <span className="font-medium text-emerald-700 dark:text-emerald-400">
                                    {formatValue(c.to)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                          {e.details && (
                            <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-[10px] leading-relaxed">
                              {JSON.stringify(
                                e.source === "money" ? e.details : (context ?? {}),
                                null,
                                2,
                              )}
                            </pre>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[12px] whitespace-nowrap">
                      {e.company_name ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-[12px] whitespace-nowrap tabular-nums">
                      {e.amount === null || e.amount === 0
                        ? <span className="text-muted-foreground">—</span>
                        : formatRM(e.amount)}
                    </td>
                    <td className="px-2 py-2">
                      {expandable && (
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : key)}
                          aria-label={isOpen ? "Hide details" : "Show details"}
                          className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t bg-muted/20 px-4 py-2.5">
          <span className="text-[12px] text-muted-foreground">
            {loading ? "Loading…" : `${pageStart}–${pageEnd} of ${total.toLocaleString()}`}
          </span>
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={!canPrev || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              className="cursor-pointer"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canNext || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              className="cursor-pointer"
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

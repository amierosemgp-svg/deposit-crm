"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Download,
  Gift,
  Hash,
  Search,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { ListLoading } from "@/components/list-loading";
import { StatTile } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/status-badge";
import { useStore } from "@/lib/store";
import { formatRM, formatShortDateTime } from "@/lib/format";
import { REPORT_DEFS, REPORT_TONE_CLASSES } from "@/lib/report-defs";
import { cn } from "@/lib/utils";
import type {
  DepositStatus,
  ReferralBonusStatus,
  WithdrawalStatus,
} from "@/lib/types";

const DEPOSIT_STATUSES: DepositStatus[] = [
  "pending_match",
  "matched",
  "pending",
  "approved",
  "processing",
  "completed",
  "failed",
];
const WITHDRAWAL_STATUSES: WithdrawalStatus[] = [
  "requested",
  "credits_pulled",
  "paid",
  "failed",
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

type Cell = { node: React.ReactNode; csv: string | number };

/** One bonus payout, deposit or recommend, as plain data (no JSX). */
/**
 * One response from a report endpoint under /api/reports/.
 *
 * Every report on this page is totalled server-side. They used to be computed
 * in the browser over the Zustand store, which holds only the newest few
 * hundred rows of each table — so any period bigger than that silently
 * reported a fraction of itself (an imported month of 9,037 deposits showed
 * RM 12,526 of a real RM 69,164 in bonuses). A report's headline is an
 * aggregate over the whole period, so paging alone could never fix it: the
 * sums have to happen where all the rows are.
 *
 * `summary` is always over the entire filtered period, never the page on
 * screen, so a card can't disagree with the table beneath it. `rows` is one
 * page for the transaction reports and the whole (small) result for the
 * rollups — `total > rows.length` is what says a pager is needed.
 */
type ReportApi = {
  summary: Record<string, number>;
  rows: Record<string, unknown>[];
  /** Bonus Payout level 1 only: the per-game rollup. */
  games?: {
    game: string;
    payouts: number;
    deposit_count: number;
    recommend_count: number;
    free_credit_count: number;
    basis: number;
    bonus: number;
  }[];
  total: number;
  limit: number;
  offset: number;
};

/** Report id → its route segment under /api/reports/. */
const REPORT_ENDPOINT: Record<string, string> = {
  daily_deposits: "daily-deposits",
  daily_withdrawals: "daily-withdrawals",
  daily_report: "daily-report",
  sales_report: "sales-report",
  win_loss: "win-loss",
  cs_performance: "cs-performance",
  bonus_payout: "bonus-payout",
  bank_reconciliation: "bank-reconciliation",
};

type DepositRow = {
  deposit_id: number;
  deposit_date: string;
  approved_at: string | null;
  transaction_ref: string;
  player: string;
  company: string;
  game: string;
  status: DepositStatus;
  agent: string;
  deposit_amount: number;
  bonus_amount: number;
  bonus_percentage: number;
  total_amount: number;
};

type WithdrawalRow = {
  withdrawal_id: number;
  created_at: string;
  player: string;
  company: string;
  game_name: string;
  bank_name: string | null;
  bank_account_number: string | null;
  status: WithdrawalStatus;
  agent: string;
  requested_amount: number;
  credit_pulled_amount: number;
};

type DailyRow = {
  day: string;
  deposits: number;
  ap: number;
  np: number;
  bonus: number;
  withdrawals: number;
  free_credit: number;
  recommend: number;
  sales: number;
  sales_cumulative: number;
  bank_balance: number;
};

type SalesRow = {
  company_id: number;
  company_name: string;
  deposits: number;
  deposit_count: number;
  ap: number;
  np: number;
  bonus: number;
  free_credit: number;
  withdrawals: number;
  withdrawal_count: number;
  recommend: number;
  sales: number;
};

type WinLossRow = {
  game: string;
  money_in: number;
  deposit_count: number;
  players: number;
  bonus: number;
  free_credit: number;
  money_out: number;
  withdrawal_count: number;
  recommend: number;
  net: number;
  margin: number | null;
};

type AgentRow = {
  user_id: number;
  full_name: string;
  username: string | null;
  dep_count: number;
  dep_volume: number;
  wd_count: number;
  wd_volume: number;
  txn_count: number;
  total_volume: number;
};

type ReconRow = {
  deposit_id: number;
  deposit_date: string;
  transaction_ref: string;
  bank_name: string;
  bank_account_holder: string | null;
  deposit_amount: number;
  status: DepositStatus;
  game_topup_reference: string | null;
  flag: string;
};

type PayoutRow = {
  key: string;
  kind: "Deposit" | "Recommend" | "Free Credit";
  at: string;
  ref: string;
  player_id: number | null;
  player: string;
  company: string;
  game: string;
  status: DepositStatus | ReferralBonusStatus;
  pct: number;
  basis: number;
  bonus: number;
};

const REPORT_PAGE_SIZE = 100;

/**
 * One column per tile above a phone. Spelled out rather than interpolated
 * because Tailwind only ships the classes it can see written down.
 */
const TILE_COLUMNS: Record<number, string> = {
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-5",
};

/**
 * The reports whose rows open into something narrower, and how.
 *
 * `into` writes the drill onto the request — what that means is the report's
 * own business: Bonus Payout narrows to one game, Sales Report re-groups one
 * company by day. Keeping it here rather than in the table builders means the
 * fetch, the CSV and the back button cannot disagree about which view is on
 * screen, which is how the export ends up holding a different table from the
 * one that was exported.
 */
const DRILL: Record<
  string,
  { into: (sp: URLSearchParams, value: string) => void; back: string } | undefined
> = {
  bonus_payout: {
    into: (sp, game) => sp.set("game", game),
    back: "All games",
  },
  sales_report: {
    into: (sp, companyId) => {
      // Overrides the company filter on purpose: inside a company, that is
      // the company being looked at.
      sp.set("company", companyId);
      sp.set("group", "day");
    },
    back: "All companies",
  },
};

type Row = {
  key: React.Key;
  cells: Cell[];
  /**
   * Makes the row a drilldown link: clicking replaces the whole table with a
   * narrower view. Preferred over expanding in place because the two levels
   * answer different questions and want different columns — a game summary and
   * a payout list have almost nothing in common to share a grid with.
   */
  onClick?: () => void;
};
type PreparedTable = {
  headers: { label: string; align?: "right" }[];
  rows: Row[];
  /** Footer cells aligned with headers; null = empty cell. */
  totals?: (React.ReactNode | null)[];
  summary?: string;
};

/** "1 Aug" from a date the server hands back as YYYY-MM-DD. */
function dayLabel(day: string): string {
  const d = new Date(`${String(day).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? String(day).slice(0, 10)
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase();

/**
 * A fetched row as CSV cells, in the same order as the table's headers.
 *
 * The on-screen rows carry their own `csv` values, but an export covers pages
 * that were never rendered, so the projection has to exist independently of
 * the cells. Keep this in step with the headers in `table`.
 */
function csvCellsOf(
  reportId: string,
  row: Record<string, unknown>,
): (string | number)[] {
  const at = (iso: unknown) =>
    typeof iso === "string" ? iso.slice(0, 16).replace("T", " ") : "";
  const v = (k: string) => (row[k] ?? "") as string | number;
  switch (reportId) {
    case "daily_deposits":
      return [
        at(row.deposit_date), at(row.approved_at), v("transaction_ref"),
        v("player"), v("company"), v("game"), v("status"), v("agent"),
        v("deposit_amount"), v("bonus_amount"), v("total_amount"),
      ];
    case "daily_withdrawals":
      return [
        at(row.created_at), `WD-${v("withdrawal_id")}`, v("player"),
        v("company"), v("game_name"),
        [row.bank_name, row.bank_account_number].filter(Boolean).join(" "),
        v("status"), v("agent"), v("requested_amount"), v("credit_pulled_amount"),
      ];
    case "bank_reconciliation":
      return [
        at(row.deposit_date), v("transaction_ref"), v("bank_name"),
        v("bank_account_holder"), v("deposit_amount"), v("status"),
        v("game_topup_reference"), v("flag"),
      ];
    case "bonus_payout":
      return [
        at(row.at), v("kind"), v("ref"), v("player"), v("company"),
        v("status"), v("pct"), v("basis"), v("bonus"),
      ];
    default:
      return Object.values(row) as (string | number)[];
  }
}

export default function ReportDetailPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const def = REPORT_DEFS.find((r) => r.id === reportId);

  // The only thing this page still takes from the store is the company list
  // for the filter. Every figure comes from /api/reports/* — see ReportApi.
  const companies = useStore((s) => s.companies)();

  const [dateFrom, setDateFrom] = useState(daysAgoStr(7));
  const [dateTo, setDateTo] = useState(todayStr());
  const [companyId, setCompanyId] = useState("all");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  /**
   * The row being drilled into, or null for the summary.
   *
   * Two reports drill: Bonus Payout into a game's payouts, Sales Report into a
   * company's days. `drill` is what the URL needs (a game name, a company id)
   * and `drillLabel` is what the heading shows — kept beside it because once
   * you are inside a company the rows are days and no longer carry its name.
   *
   * Cleared whenever a filter moves: the thing drilled into may no longer be
   * in range, and an empty table with no explanation reads as a bug.
   */
  const [drill, setDrill] = useState<string | null>(null);
  const [drillLabel, setDrillLabel] = useState<string | null>(null);
  const openDrill = useCallback((value: string, label: string) => {
    setDrill(value);
    setDrillLabel(label);
  }, []);
  const closeDrill = useCallback(() => {
    setDrill(null);
    setDrillLabel(null);
  }, []);
  /** Bonus Payout only: deposit bonuses, recommend bonuses, or both. */
  const [payoutKind, setPayoutKind] = useState<
    "all" | "Deposit" | "Recommend" | "Free Credit"
  >(
    "all",
  );

  const q = norm(query.trim());

  /**
   * The report, fetched. See ReportApi for why none of this is derived from
   * the store any more.
   */
  const [report, setReport] = useState<ReportApi | null>(null);
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);

  const reportQuery = useMemo(() => {
    const sp = new URLSearchParams();
    if (dateFrom) sp.set("from", dateFrom);
    if (dateTo) sp.set("to", dateTo);
    if (companyId !== "all") sp.set("company", companyId);
    if (status !== "all") sp.set("status", status);
    if (payoutKind !== "all") sp.set("type", payoutKind);
    if (q) sp.set("q", q);
    return sp.toString();
  }, [dateFrom, dateTo, companyId, status, payoutKind, q]);

  // Drop the drill and the page when a filter moves: the game may no longer
  // have any payouts, and an empty table with no explanation reads as a bug.
  // Derived during render rather than in an effect, so it settles before paint.
  const [prevQuery, setPrevQuery] = useState(reportQuery);
  if (reportQuery !== prevQuery) {
    setPrevQuery(reportQuery);
    if (drill !== null) closeDrill();
    if (offset !== 0) setOffset(0);
  }

  /** The URL for one view, so the fetch and the CSV can't diverge. */
  const reportUrl = useCallback(
    (into: string | null, at: number, limit: number) => {
      const endpoint = def ? REPORT_ENDPOINT[def.id] : null;
      if (!endpoint) return null;
      const sp = new URLSearchParams(reportQuery);
      if (into !== null && def) DRILL[def.id]?.into(sp, into);
      sp.set("limit", String(limit));
      sp.set("offset", String(at));
      return `/api/reports/${endpoint}?${sp}`;
    },
    [def, reportQuery],
  );

  // The view being asked for, and the one already answered. Loading is the gap
  // between them — a derived value rather than a flag an effect has to set,
  // which keeps the fetch from triggering a render before it has any news.
  const want = reportUrl(drill, offset, REPORT_PAGE_SIZE);
  const [have, setHave] = useState<string | null>(null);
  const loading = want !== null && want !== have;

  // A stale response must never overwrite a fresh one: the filters move faster
  // than the network, and the last request to *start* is not always the last to
  // land. Each run claims a ticket and only the newest one may write.
  const run = useRef(0);
  useEffect(() => {
    if (!want) return;
    const ticket = ++run.current;
    fetch(want)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: ReportApi) => {
        if (ticket !== run.current) return;
        setReport(data);
        setHave(want);
      })
      .catch(() => {
        if (ticket !== run.current) return;
        setReport(null);
        // Marked answered even though it failed, or the spinner never stops.
        setHave(want);
        toast.error("Could not load the report");
      });
  }, [want]);

  const table: PreparedTable | null = useMemo(() => {
    if (!def) return null;
    if (!report) return { headers: [], rows: [] };

    /** Footer label, so a page-limited table never claims to be the whole set. */
    const allPagesLabel =
      report.total > report.rows.length ? "Totals · all pages" : "Totals";
    /** "101–200 of 9,037", or nothing when it all fits on one page. */
    const pageSummary = () =>
      report.total > report.rows.length
        ? `${(report.offset + 1).toLocaleString()}–${Math.min(report.offset + report.rows.length, report.total).toLocaleString()} of ${report.total.toLocaleString()}.`
        : "";

    const money = (n: number): Cell => ({ node: formatRM(n), csv: n });
    const text = (s: string): Cell => ({ node: s, csv: s });
    const mono = (s: string): Cell => ({
      node: <span className="font-mono text-[11px]">{s}</span>,
      csv: s,
    });
    const when = (iso: string): Cell => ({
      node: (
        <span className="whitespace-nowrap">{formatShortDateTime(iso)}</span>
      ),
      csv: iso.slice(0, 16).replace("T", " "),
    });
    /** when(), for a moment that may not have arrived — an unapproved deposit. */
    const whenOrNever = (iso: string | null | undefined): Cell =>
      iso
        ? when(iso)
        : {
            node: <span className="text-muted-foreground">—</span>,
            csv: "",
          };
    const badge = (
      s: DepositStatus | WithdrawalStatus | ReferralBonusStatus,
    ): Cell => ({
      node: <StatusBadge status={s} />,
      csv: s,
    });

    switch (def.id) {
      case "daily_deposits": {
        const rows = (report.rows as DepositRow[]).map((d) => ({
          key: d.deposit_id,
          cells: [
            when(d.deposit_date),
            whenOrNever(d.approved_at),
            mono(d.transaction_ref),
            text(d.player),
            text(d.company),
            text(d.game),
            badge(d.status),
            text(d.agent),
            money(d.deposit_amount),
            {
              node: (
                <span>
                  {formatRM(d.bonus_amount)}
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    ({d.bonus_percentage}%)
                  </span>
                </span>
              ),
              csv: d.bonus_amount,
            },
            money(d.total_amount),
          ],
        }));
        return {
          headers: [
            { label: "Date" },
            { label: "Approved" },
            { label: "Ref" },
            { label: "Player" },
            { label: "Company" },
            { label: "Game" },
            { label: "Status" },
            { label: "CS Agent" },
            { label: "Amount", align: "right" },
            { label: "Bonus", align: "right" },
            { label: "Total", align: "right" },
          ],
          rows,
          // The period, not the page: a footer summing the visible hundred
          // would contradict the card above it.
          totals: [
            allPagesLabel,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            formatRM(report.summary.amount),
            formatRM(report.summary.bonus),
            formatRM(report.summary.total),
          ],
          summary: pageSummary(),
        };
      }

      case "daily_withdrawals": {
        const rows = (report.rows as WithdrawalRow[]).map((w) => ({
          key: w.withdrawal_id,
          cells: [
            when(w.created_at),
            mono(`WD-${w.withdrawal_id}`),
            text(w.player),
            text(w.company),
            text(w.game_name),
            text(
              w.bank_name
                ? `${w.bank_name}${w.bank_account_number ? ` ${w.bank_account_number}` : ""}`
                : (w.bank_account_number ?? "—"),
            ),
            badge(w.status),
            text(w.agent),
            money(w.requested_amount),
            money(w.credit_pulled_amount),
          ],
        }));
        return {
          headers: [
            { label: "Date" },
            { label: "ID" },
            { label: "Player" },
            { label: "Company" },
            { label: "Game" },
            { label: "Bank" },
            { label: "Status" },
            { label: "CS Agent" },
            { label: "Requested", align: "right" },
            { label: "Pulled", align: "right" },
          ],
          rows,
          totals: [
            allPagesLabel,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            formatRM(report.summary.requested),
            formatRM(report.summary.pulled),
          ],
          summary: pageSummary(),
        };
      }

      case "daily_report": {
        const signed = (n: number): Cell => ({
          node: (
            <span
              className={cn(
                "font-medium",
                n >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400",
              )}
            >
              {formatRM(n)}
            </span>
          ),
          csv: n,
        });
        const rows = report.rows as DailyRow[];
        return {
          headers: [
            { label: "Date" },
            { label: "Total Deposit", align: "right" },
            { label: "AP", align: "right" },
            { label: "NP", align: "right" },
            { label: "Bonus", align: "right" },
            { label: "Withdrawals", align: "right" },
            { label: "Sales", align: "right" },
            { label: "Cumulative", align: "right" },
            { label: "Bank Balance", align: "right" },
          ],
          rows: rows.map((r) => ({
            key: r.day,
            cells: [
              { node: dayLabel(r.day), csv: String(r.day).slice(0, 10) },
              money(r.deposits),
              { node: r.ap.toLocaleString(), csv: r.ap },
              { node: r.np.toLocaleString(), csv: r.np },
              money(r.bonus),
              money(r.withdrawals),
              signed(r.sales),
              signed(r.sales_cumulative),
              money(r.bank_balance),
            ],
          })),
          totals: [
            "Totals",
            formatRM(report.summary.deposits),
            `avg ${Math.round(report.summary.avg_ap).toLocaleString()}`,
            report.summary.np.toLocaleString(),
            formatRM(report.summary.bonus),
            formatRM(report.summary.withdrawals),
            formatRM(report.summary.sales),
            null,
            null,
          ],
          summary:
            `${report.summary.days} days · avg ${formatRM(report.summary.avg_deposits)} deposits a day · ` +
            `free credit ${formatRM(report.summary.free_credit)} · recommend ${formatRM(report.summary.recommend)}. ` +
            "Sales = deposits − withdrawals − bonus − recommend − free credit. AP is averaged, not summed: the same member active on ten days is one player.",
        };
      }

      case "sales_report": {
        const signed = (n: number): Cell => ({
          node: (
            <span
              className={cn(
                "font-medium",
                n >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400",
              )}
            >
              {formatRM(n)}
            </span>
          ),
          csv: n,
        });
        const rows = report.rows as SalesRow[];
        /**
         * Drilled in, the same columns are a company's days — the server
         * re-groups the identical arithmetic, so the days always add back up
         * to the row that was clicked. Only the first column differs: a
         * company name at the top level, a date underneath it.
         */
        const intoDays = drill !== null;
        return {
          headers: [
            { label: intoDays ? "Day" : "Company" },
            { label: "Deposits", align: "right" },
            { label: "AP", align: "right" },
            { label: "NP", align: "right" },
            { label: "Bonus", align: "right" },
            { label: "Free Credit", align: "right" },
            { label: "Recommend", align: "right" },
            { label: "Withdrawals", align: "right" },
            { label: "Sales", align: "right" },
          ],
          rows: rows.map((r) => ({
            key: r.company_id,
            cells: [
              intoDays
                ? { node: dayLabel(r.company_name), csv: r.company_name }
                : {
                    // The chevron is the only thing saying the row opens —
                    // same mark Bonus Payout uses on its games.
                    node: (
                      <span className="flex items-center gap-1.5 font-medium">
                        {r.company_name}
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      </span>
                    ),
                    csv: r.company_name,
                  },
              money(r.deposits),
              { node: r.ap.toLocaleString(), csv: r.ap },
              { node: r.np.toLocaleString(), csv: r.np },
              money(r.bonus),
              money(r.free_credit),
              money(r.recommend),
              money(r.withdrawals),
              signed(r.sales),
            ],
            // Top level only: a day has nothing narrower to open into.
            ...(intoDays
              ? {}
              : {
                  onClick: () =>
                    openDrill(String(r.company_id), r.company_name),
                }),
          })),
          totals: [
            "Totals",
            formatRM(report.summary.deposits),
            report.summary.ap.toLocaleString(),
            report.summary.np.toLocaleString(),
            formatRM(report.summary.bonus),
            formatRM(report.summary.free_credit),
            formatRM(report.summary.recommend),
            formatRM(report.summary.withdrawals),
            formatRM(report.summary.sales),
          ],
          summary: intoDays
            ? `${drillLabel} day by day — these ${rows.length.toLocaleString()} rows add up to its line on the summary.`
            : report.summary.days > 0
              ? `${formatRM(report.summary.sales_per_day)} a day over ${report.summary.days} days. Click a company for its days.`
              : "Same arithmetic as the Daily Report, by company instead of by day.",
        };
      }

      case "win_loss": {
        const signed = (n: number): Cell => ({
          node: (
            <span
              className={cn(
                "font-medium",
                n >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400",
              )}
            >
              {formatRM(n)}
            </span>
          ),
          csv: n,
        });
        const rows = report.rows as WinLossRow[];
        return {
          headers: [
            { label: "Game" },
            { label: "Money In", align: "right" },
            { label: "Players", align: "right" },
            { label: "Bonus", align: "right" },
            { label: "Free Credit", align: "right" },
            { label: "Recommend", align: "right" },
            { label: "Paid Out", align: "right" },
            { label: "Net", align: "right" },
            { label: "Margin", align: "right" },
          ],
          rows: rows.map((r) => ({
            key: r.game,
            cells: [
              text(r.game),
              money(r.money_in),
              { node: r.players.toLocaleString(), csv: r.players },
              money(r.bonus),
              money(r.free_credit),
              money(r.recommend),
              money(r.money_out),
              signed(r.net),
              {
                // Margin on nothing is undefined, not 0% — a dash says so.
                node:
                  r.margin === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    `${r.margin}%`
                  ),
                csv: r.margin ?? "",
              },
            ],
          })),
          totals: [
            "Totals",
            formatRM(report.summary.money_in),
            null,
            formatRM(report.summary.bonus),
            formatRM(report.summary.free_credit),
            formatRM(report.summary.recommend),
            formatRM(report.summary.money_out),
            formatRM(report.summary.net),
            `${report.summary.margin.toFixed(1)}%`,
          ],
          summary:
            `${report.summary.winning} ${report.summary.winning === 1 ? "game is" : "games are"} up, ` +
            `${report.summary.losing} down. Net = money in − bonus − recommend − free credit − paid out, ` +
            "so these rows add up to the Daily and Sales reports.",
        };
      }

      case "cs_performance": {
        return {
          headers: [
            { label: "Agent" },
            { label: "Deposits", align: "right" },
            { label: "Deposit Volume", align: "right" },
            { label: "Withdrawals", align: "right" },
            { label: "Withdrawal Volume", align: "right" },
            { label: "Transactions", align: "right" },
            { label: "Total Volume", align: "right" },
          ],
          rows: (report.rows as AgentRow[]).map((a) => ({
            key: a.user_id,
            cells: [
              {
                node: (
                  <span>
                    <span className="font-medium">{a.full_name}</span>
                    {a.username && (
                      <span className="ml-1.5 text-[11px] text-muted-foreground">
                        @{a.username}
                      </span>
                    )}
                  </span>
                ),
                csv: a.username ?? a.full_name,
              },
              { node: a.dep_count, csv: a.dep_count },
              money(a.dep_volume),
              { node: a.wd_count, csv: a.wd_count },
              money(a.wd_volume),
              { node: a.txn_count, csv: a.txn_count },
              money(a.total_volume),
            ],
          })),
          totals: [
            "Totals",
            report.summary.dep_count,
            formatRM(report.summary.dep_volume),
            report.summary.wd_count,
            formatRM(report.summary.wd_volume),
            report.summary.dep_count + report.summary.wd_count,
            formatRM(report.summary.dep_volume + report.summary.wd_volume),
          ],
          summary: "Only transactions with a handling CS agent are counted.",
        };
      }

      case "bonus_payout": {
        // Every figure here is the server's. Nothing is re-totalled in the
        // browser, so the table cannot drift from the cards above it.

        // ---- Level 1: one row per game. Click a row to drill in. ----
        if (drill === null) {
          return {
            headers: [
              { label: "Game" },
              { label: "Payouts", align: "right" },
              { label: "Deposit bonuses", align: "right" },
              { label: "Recommend bonuses", align: "right" },
              { label: "Free credits", align: "right" },
              { label: "Deposit Volume", align: "right" },
              { label: "Bonus Paid", align: "right" },
            ],
            rows: (report.games ?? []).map((g) => ({
              key: `game-${g.game}`,
              onClick: () => openDrill(g.game, g.game),
              cells: [
                {
                  node: (
                    <span className="flex items-center gap-1.5 font-medium">
                      {g.game}
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                  ),
                  csv: g.game,
                },
                { node: g.payouts, csv: g.payouts },
                { node: g.deposit_count, csv: g.deposit_count },
                { node: g.recommend_count, csv: g.recommend_count },
                { node: g.free_credit_count, csv: g.free_credit_count },
                { node: formatRM(g.basis), csv: g.basis },
                { node: formatRM(g.bonus), csv: g.bonus },
              ],
            })),
            totals: [
              "Totals",
              report.summary.deposit_count +
                report.summary.recommend_count +
                report.summary.free_credit_count,
              report.summary.deposit_count,
              report.summary.recommend_count,
              report.summary.free_credit_count,
              formatRM(report.summary.basis),
              formatRM(
                report.summary.deposit_bonus +
                  report.summary.recommend_bonus +
                  report.summary.free_credit,
              ),
            ],
            summary:
              "Everything the house gave away: bonus on a deposit, recommend bonus paid to an upline, and free credit issued with no deposit behind it. " +
              "Click a game to see its payouts. Deposits with no bonus are excluded; cancelled recommend bonuses are written off and excluded.",
          };
        }

        // ---- Level 2: one game's payouts, one page at a time. ----
        const shown = report.rows as PayoutRow[];
        const last = Math.min(offset + shown.length, report.total);
        return {
          headers: [
            { label: "Date" },
            { label: "Type" },
            { label: "Ref" },
            { label: "Player" },
            { label: "Company" },
            { label: "Status" },
            { label: "Bonus %", align: "right" },
            { label: "Deposit", align: "right" },
            { label: "Bonus Paid", align: "right" },
          ],
          rows: shown.map((p) => ({
            key: p.key,
            cells: [
              when(p.at),
              {
                node: (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                      p.kind === "Recommend"
                        ? "bg-purple-500/10 text-purple-700 dark:text-purple-300"
                        : p.kind === "Free Credit"
                          ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
                          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    )}
                  >
                    {p.kind}
                  </span>
                ),
                csv: p.kind,
              },
              mono(p.ref),
              text(p.player),
              text(p.company),
              badge(p.status),
              { node: `${p.pct}%`, csv: p.pct },
              money(p.basis),
              money(p.bonus),
            ],
          })),
          // The whole game, not this page: a footer that totalled the visible
          // hundred rows would contradict the card above it.
          totals: [
            "Totals · all pages",
            null,
            null,
            null,
            null,
            null,
            null,
            formatRM(report.summary.basis),
            formatRM(
              report.summary.deposit_bonus +
                report.summary.recommend_bonus +
                report.summary.free_credit,
            ),
          ],
          summary:
            report.total > shown.length
              ? `Bonus payouts for ${drillLabel} · ${(offset + 1).toLocaleString()}–${last.toLocaleString()} of ${report.total.toLocaleString()}.`
              : `Bonus payouts for ${drillLabel}.`,
        };
      }

      case "bank_reconciliation": {
        const rows = (report.rows as ReconRow[]).map((d) => {
          const ok = d.flag === "OK";
          return {
            key: d.deposit_id,
            cells: [
              when(d.deposit_date),
              mono(d.transaction_ref),
              text(d.bank_name),
              text(d.bank_account_holder ?? "—"),
              money(d.deposit_amount),
              badge(d.status),
              mono(d.game_topup_reference ?? "—"),
              {
                node: (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 text-[11px] font-medium",
                      ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {ok ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <AlertTriangle className="h-3 w-3" />
                    )}
                    {d.flag}
                  </span>
                ),
                csv: d.flag,
              },
            ],
          };
        });
        // Counted over the period, not the page: "how many discrepancies this
        // month" is the question, and a page of a hundred cannot answer it.
        const issues = report.summary.issues;
        return {
          headers: [
            { label: "Date" },
            { label: "Ref" },
            { label: "Bank" },
            { label: "Account Holder" },
            { label: "Amount", align: "right" },
            { label: "CRM Status" },
            { label: "Top-up Ref" },
            { label: "Flag" },
          ],
          rows,
          totals: [
            allPagesLabel,
            null,
            null,
            null,
            formatRM(report.summary.amount),
            null,
            null,
            `${issues.toLocaleString()} flagged`,
          ],
          summary:
            (issues === 0
              ? "No discrepancies in this period."
              : `${issues.toLocaleString()} discrepanc${issues === 1 ? "y" : "ies"} flagged.`) +
            (pageSummary() ? ` ${pageSummary()}` : ""),
        };
      }

      default:
        return null;
    }
  }, [def, report, offset, drill, drillLabel, openDrill]);

  // Summary tiles shown above the table for the transaction-style reports.
  const summaryTiles: {
    title: string;
    value: string;
    sub?: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = useMemo(() => {
    if (!def) return [];
    switch (def.id) {
      case "daily_deposits": {
        if (!report) return [];
        return [
          {
            title: "Total Deposit Amount",
            value: formatRM(report.summary.amount),
            sub: `${formatRM(report.summary.bonus)} bonus · ${formatRM(report.summary.total)} credited`,
            icon: Wallet,
          },
          {
            title: "Unique Players",
            value: report.summary.unique_players.toLocaleString(),
            sub: "deposited in this period",
            icon: Users,
          },
          {
            title: "Transactions",
            value: report.summary.count.toLocaleString(),
            icon: Hash,
          },
        ];
      }
      case "daily_withdrawals": {
        if (!report) return [];
        return [
          {
            title: "Total Withdrawal Amount",
            value: formatRM(report.summary.requested),
            sub: `${formatRM(report.summary.pulled)} actually pulled`,
            icon: Wallet,
          },
          {
            title: "Unique Players",
            value: report.summary.unique_players.toLocaleString(),
            sub: "withdrew in this period",
            icon: Users,
          },
          {
            title: "Transactions",
            value: report.summary.count.toLocaleString(),
            icon: Hash,
          },
        ];
      }
      case "sales_report": {
        if (!report) return [];
        /**
         * The server's own summary, from the same request that drew the table.
         * It covers every row the filters admit, not the page on screen, and
         * drilled into a company it narrows to that company — so the tiles
         * always describe exactly what is underneath them.
         */
        const { summary } = report;
        const givenAway = summary.bonus + summary.free_credit + summary.recommend;
        // Inside a company the rows are its days, so the scope is worth saying
        // out loud — the figures have narrowed and the tiles should admit it.
        const scope = drillLabel ? `${drillLabel} · ` : "";
        const tiles = [
          {
            title: "Sales",
            value: formatRM(summary.sales),
            sub:
              summary.days > 0
                ? `${scope}${formatRM(summary.sales_per_day)} a day over ${summary.days} day${summary.days === 1 ? "" : "s"}`
                : `${scope}deposits less everything paid out`,
            icon: TrendingUp,
          },
          {
            title: "Deposits",
            value: formatRM(summary.deposits),
            sub: `${formatRM(summary.withdrawals)} withdrawn`,
            icon: Wallet,
          },
          {
            title: "Players",
            value: summary.ap.toLocaleString(),
            sub: `active · ${summary.np.toLocaleString()} new`,
            icon: Users,
          },
          {
            title: "Given Away",
            value: formatRM(givenAway),
            sub: `${formatRM(summary.bonus)} bonus · ${formatRM(summary.recommend)} recommend · ${formatRM(summary.free_credit)} free credit`,
            icon: Gift,
          },
        ];
        if (drill === null) return tiles;

        /**
         * One tile the summary cannot have: which day carried the company.
         *
         * Taken from the rows rather than asked of the server, and safe to do
         * here only because this report is never paged — every day in the
         * period is on screen, so the best of them really is the best.
         */
        const days = report.rows as SalesRow[];
        const best = days.reduce<SalesRow | null>(
          (top, d) => (top === null || d.sales > top.sales ? d : top),
          null,
        );
        return [
          ...tiles,
          {
            title: "Best Day",
            value: best ? dayLabel(best.company_name) : "—",
            sub: best ? `${formatRM(best.sales)} sales` : "no days in range",
            icon: CalendarDays,
          },
        ];
      }

      case "bonus_payout": {
        // The same summary object the table's footer uses, scoped by the same
        // request — so a card can never quietly disagree with the rows beneath
        // it, and neither is limited to the page on screen.
        if (!report) return [];
        const { summary } = report;
        const total =
          summary.deposit_bonus + summary.recommend_bonus + summary.free_credit;
        const count =
          summary.deposit_count +
          summary.recommend_count +
          summary.free_credit_count;
        const scope = drillLabel ? ` · ${drillLabel}` : "";
        return [
          {
            title: "Total Bonus Amount",
            value: formatRM(total),
            sub: `${formatRM(summary.deposit_bonus)} deposit · ${formatRM(summary.recommend_bonus)} recommend · ${formatRM(summary.free_credit)} free credit${scope}`,
            icon: Gift,
          },
          {
            title: "Unique Players",
            value: summary.unique_players.toLocaleString(),
            sub: "received something",
            icon: Users,
          },
          {
            title: drill ? "Payouts" : "Bonus Transactions",
            value: count.toLocaleString(),
            sub: `${summary.deposit_count.toLocaleString()} deposit · ${summary.recommend_count.toLocaleString()} recommend · ${summary.free_credit_count.toLocaleString()} free credit`,
            icon: Hash,
          },
        ];
      }
      default:
        return [];
    }
  }, [def, report, drill, drillLabel]);

  if (!def || !table) {
    return (
      <div className="space-y-4">
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Unknown report “{reportId}”.
        </Card>
      </div>
    );
  }

  const Icon = def.icon;
  const statusOptions =
    def.id === "daily_withdrawals"
      ? WITHDRAWAL_STATUSES
      : ["daily_deposits", "bonus_payout", "bank_reconciliation"].includes(def.id)
        ? DEPOSIT_STATUSES
        : null;

  function setPreset(days: number | null) {
    if (days === null) {
      setDateFrom("");
      setDateTo("");
    } else {
      setDateFrom(daysAgoStr(days));
      setDateTo(todayStr());
    }
  }

  /**
   * Every row the current filters match, not just the page on screen.
   *
   * The tables page at 100 because nobody reads 9,037 rows in a browser, but a
   * CSV of the visible hundred silently answers a different question than the
   * one asked. Pulled 500 at a time against the same URL builder the table
   * used, so the export and the total on screen come from one filter.
   */
  async function fetchAllRows(): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let at = 0; ; at += 500) {
      const url = reportUrl(drill, at, 500);
      if (!url) return out;
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const page: ReportApi = await res.json();
      out.push(...page.rows);
      if (out.length >= page.total || page.rows.length === 0) return out;
    }
  }

  async function exportCsv() {
    if (!table || !def) return;
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    let bodyRows = table.rows.map((r) => r.cells.map((c) => esc(c.csv)).join(","));
    // Only worth re-fetching when the table is showing a slice of something
    // bigger; a rollup already has every row on screen.
    if (report && report.total > report.rows.length) {
      setExporting(true);
      try {
        const all = await fetchAllRows();
        bodyRows = all.map((row) =>
          csvCellsOf(def.id, row).map(esc).join(","),
        );
      } catch {
        toast.error("Could not export — try a narrower date range");
        return;
      } finally {
        setExporting(false);
      }
    }

    const lines = [
      table.headers.map((h) => esc(h.label)).join(","),
      ...bodyRows,
    ];
    const blob = new Blob(["\ufeff" + lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${def.id}_${dateFrom || "all"}_to_${dateTo || "all"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${lines.length - 1} rows to CSV`);
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                REPORT_TONE_CLASSES[def.tone],
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold leading-tight">
                {def.title}
                {drillLabel && (
                  <span className="text-muted-foreground"> · {drillLabel}</span>
                )}
              </h1>
              {drill ? (
                // A way back out. Without it the only route to the summary is a
                // full page reload, since the drill lives in component state.
                <button
                  onClick={closeDrill}
                  className="mt-0.5 inline-flex cursor-pointer items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {DRILL[def.id]?.back ?? "Back"}
                </button>
              ) : (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {def.description}
                </p>
              )}
            </div>
          </div>
          <Button
            onClick={exportCsv}
            disabled={exporting}
            className="shrink-0 cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <span className="block text-[11px] font-medium text-muted-foreground">
                From
              </span>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-8 w-[140px]"
              />
            </div>
            <div className="space-y-1">
              <span className="block text-[11px] font-medium text-muted-foreground">
                To
              </span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-8 w-[140px]"
              />
            </div>
            <div className="flex gap-1 pb-0.5">
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
          </div>

          <div className="space-y-1">
            <span className="block text-[11px] font-medium text-muted-foreground">
              Company
            </span>
            <Select
              value={companyId}
              onValueChange={(v) => setCompanyId(v ?? "all")}
              items={[
                { value: "all", label: "All Companies" },
                ...companies.map((c) => ({
                  value: String(c.company_id),
                  label: c.company_name,
                })),
              ]}
            >
              <SelectTrigger className="h-8 w-[170px] cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="cursor-pointer">
                  All Companies
                </SelectItem>
                {companies.map((c) => (
                  <SelectItem
                    key={c.company_id}
                    value={String(c.company_id)}
                    className="cursor-pointer"
                  >
                    {c.company_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Bonus Payout mixes two genuinely different payouts — a deposit's
              own bonus and a recommend bonus paid to an upline — so being able
              to look at one at a time is the point of the Type column. */}
          {def.id === "bonus_payout" && (
            <div className="space-y-1">
              <span className="block text-[11px] font-medium text-muted-foreground">
                Type
              </span>
              <Select
                value={payoutKind}
                onValueChange={(v) =>
                  setPayoutKind((v as typeof payoutKind) ?? "all")
                }
                items={[
                  { value: "all", label: "All Types" },
                  { value: "Deposit", label: "Deposit bonus" },
                  { value: "Recommend", label: "Recommend bonus" },
                  { value: "Free Credit", label: "Free credit" },
                ]}
              >
                <SelectTrigger className="h-8 w-[170px] cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="cursor-pointer">
                    All Types
                  </SelectItem>
                  <SelectItem value="Deposit" className="cursor-pointer">
                    Deposit bonus
                  </SelectItem>
                  <SelectItem value="Free Credit" className="cursor-pointer">
                    Free credit
                  </SelectItem>
                  <SelectItem value="Recommend" className="cursor-pointer">
                    Recommend bonus
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Hidden in recommend-only view: these are deposit statuses, and a
              recommend bonus has its own (pending/assigned/cancelled). */}
          {statusOptions &&
            payoutKind !== "Recommend" &&
            payoutKind !== "Free Credit" && (
            <div className="space-y-1">
              <span className="block text-[11px] font-medium text-muted-foreground">
                Status
              </span>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v ?? "all")}
                items={[
                  { value: "all", label: "All Statuses" },
                  ...statusOptions.map((s) => ({
                    value: s,
                    label: s.replace(/_/g, " "),
                  })),
                ]}
              >
                <SelectTrigger className="h-8 w-[160px] cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="cursor-pointer">
                    All Statuses
                  </SelectItem>
                  {statusOptions.map((s) => (
                    <SelectItem key={s} value={s} className="cursor-pointer">
                      {s.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="min-w-[200px] flex-1 space-y-1">
            <span className="block text-[11px] font-medium text-muted-foreground">
              Search
            </span>
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Player, ref, bank, game…"
                className="h-8 pl-8"
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Summary tiles */}
      {summaryTiles.length > 0 && (
        // Two up on a phone, then one column per tile — four tiles in a
        // three-column grid left one stranded on its own row.
        <div
          className={cn(
            "grid grid-cols-2 gap-3",
            TILE_COLUMNS[summaryTiles.length] ?? "sm:grid-cols-3",
          )}
        >
          {summaryTiles.map((t) => (
            <StatTile
              key={t.title}
              title={t.title}
              value={t.value}
              sub={t.sub}
              icon={t.icon}
              compact
            />
          ))}
        </div>
      )}

      {/* Data */}
      <Card className="p-0 gap-0 overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            {table.rows.length.toLocaleString()} row
            {table.rows.length === 1 ? "" : "s"}
            {table.summary && ` · ${table.summary}`}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                {table.headers.map((h) => (
                  <th
                    key={h.label}
                    className={cn(
                      "px-3 py-2.5 font-medium whitespace-nowrap",
                      h.align === "right" ? "text-right" : "text-left",
                    )}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                <tr
                  key={r.key}
                  onClick={r.onClick}
                  className={cn(
                    "border-t",
                    r.onClick
                      ? "cursor-pointer hover:bg-primary/5"
                      : "hover:bg-muted/30",
                  )}
                >
                  {r.cells.map((c, i) => (
                    <td
                      key={i}
                      className={cn(
                        "px-3 py-2.5 text-[12px]",
                        table.headers[i]?.align === "right" &&
                          "text-right whitespace-nowrap",
                      )}
                    >
                      {c.node}
                    </td>
                  ))}
                </tr>
              ))}
              {table.rows.length === 0 && (
                <tr>
                  <td
                    colSpan={table.headers.length}
                    className="px-3 py-12 text-center text-xs text-muted-foreground"
                  >
                    {loading ? (
                      <ListLoading className="py-0" label="Loading report…" />
                    ) : (
                      "No data matches the current filters."
                    )}
                  </td>
                </tr>
              )}
            </tbody>
            {table.totals && table.rows.length > 0 && (
              <tfoot className="border-t bg-muted/40 font-medium">
                <tr>
                  {table.totals.map((t, i) => (
                    <td
                      key={i}
                      className={cn(
                        "px-3 py-2.5 text-[12px]",
                        table.headers[i]?.align === "right" &&
                          "text-right whitespace-nowrap",
                      )}
                    >
                      {t}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {/* Paged reports only: a rollup has every row on screen already. */}
        {report !== null && report.total > report.rows.length && (
          <div className="flex items-center justify-between border-t px-4 py-2.5">
            <span className="text-xs text-muted-foreground">
              Page {Math.floor(offset / REPORT_PAGE_SIZE) + 1} of{" "}
              {Math.ceil(report.total / REPORT_PAGE_SIZE).toLocaleString()}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                disabled={offset === 0 || loading}
                onClick={() =>
                  setOffset((o) => Math.max(o - REPORT_PAGE_SIZE, 0))
                }
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                disabled={offset + REPORT_PAGE_SIZE >= report.total || loading}
                onClick={() => setOffset((o) => o + REPORT_PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

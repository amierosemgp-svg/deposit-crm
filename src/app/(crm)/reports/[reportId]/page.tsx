"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Download,
  Gift,
  Hash,
  Search,
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
function inRange(iso: string, from: string, to: string) {
  const day = iso.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

type Cell = { node: React.ReactNode; csv: string | number };

/** One bonus payout, deposit or recommend, as plain data (no JSX). */
type BonusPayout = {
  key: string;
  date: string;
  kind: "Deposit" | "Recommend";
  ref: string;
  playerId: number | null;
  player: string;
  company: string;
  game: string;
  status: DepositStatus | ReferralBonusStatus;
  pct: number;
  basis: number;
  bonus: number;
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

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase();

export default function ReportDetailPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const def = REPORT_DEFS.find((r) => r.id === reportId);

  const deposits = useStore((s) => s.deposits);
  const hydrated = useStore((s) => s.hydrated);
  const withdrawals = useStore((s) => s.withdrawals);
  const referralBonuses = useStore((s) => s.referralBonuses);
  const players = useStore((s) => s.players);
  const users = useStore((s) => s.users);
  const companies = useStore((s) => s.companies)();

  const [dateFrom, setDateFrom] = useState(daysAgoStr(7));
  const [dateTo, setDateTo] = useState(todayStr());
  const [companyId, setCompanyId] = useState("all");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  /**
   * Bonus Payout only: the game being drilled into, or null for the summary.
   * Cleared whenever a filter moves — a game that no longer has payouts would
   * otherwise strand you on an empty table.
   */
  const [drillGame, setDrillGame] = useState<string | null>(null);
  /** Bonus Payout only: deposit bonuses, recommend bonuses, or both. */
  const [payoutKind, setPayoutKind] = useState<"all" | "Deposit" | "Recommend">(
    "all",
  );

  const playerById = useMemo(
    () => new Map(players.map((p) => [p.player_id, p])),
    [players],
  );
  const userById = useMemo(
    () => new Map(users.map((u) => [u.user_id, u])),
    [users],
  );
  const companyNameOf = (id: number | null | undefined) =>
    id == null
      ? "—"
      : (companies.find((c) => c.company_id === id)?.company_name ?? `#${id}`);
  const agentNameOf = (id: number | null | undefined) =>
    id == null ? "—" : (userById.get(id)?.username ?? `#${id}`);
  const playerLabelOf = (
    playerId: number | null,
    fallbackUsername?: string | null,
  ) => {
    const p = playerId != null ? playerById.get(playerId) : undefined;
    return p?.full_name ?? fallbackUsername ?? "—";
  };

  const q = norm(query.trim());

  const filteredDeposits = useMemo(
    () =>
      deposits.filter((d) => {
        if (!inRange(d.deposit_date, dateFrom, dateTo)) return false;
        if (companyId !== "all" && String(d.company_entity_id ?? "") !== companyId)
          return false;
        if (status !== "all" && d.status !== status) return false;
        if (q) {
          const p = d.player_id != null ? playerById.get(d.player_id) : undefined;
          const hay = [
            d.transaction_ref,
            d.player_username,
            p?.full_name,
            p?.username,
            d.bank_name,
            d.bank_account_holder,
            d.bank_description,
            d.selected_game,
            d.game_topup_reference,
          ]
            .map(norm)
            .join(" ");
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [deposits, dateFrom, dateTo, companyId, status, q, playerById],
  );

  /**
   * Recommend bonuses in range, scoped and searched like the deposits are.
   *
   * Dated on `assigned_at` when there is one — that is when the credit was
   * actually handed over — falling back to when it was earned for one still
   * pending. Cancelled bonuses are written off and never paid, so they are out
   * of a payout report entirely.
   *
   * The company is the *upline's*: they are the player being paid, even though
   * it was the downline's deposit that triggered it.
   */
  const filteredReferralBonuses = useMemo(
    () =>
      referralBonuses
        .filter((b) => b.status !== "cancelled")
        .filter((b) => {
          if (!inRange(b.assigned_at ?? b.created_at, dateFrom, dateTo)) {
            return false;
          }
          const upline = playerById.get(b.upline_player_id);
          if (
            companyId !== "all" &&
            String(upline?.company_entity_id ?? "") !== companyId
          ) {
            return false;
          }
          if (q) {
            const hay = [
              `REC-${b.bonus_id}`,
              upline?.full_name,
              upline?.username,
              b.downline_full_name,
              b.downline_username,
              b.game_name,
              b.note,
            ]
              .map(norm)
              .join(" ");
            if (!hay.includes(q)) return false;
          }
          return true;
        }),
    [referralBonuses, dateFrom, dateTo, companyId, q, playerById],
  );

  const filteredWithdrawals = useMemo(
    () =>
      withdrawals.filter((w) => {
        if (!inRange(w.created_at, dateFrom, dateTo)) return false;
        const p = playerById.get(w.player_id);
        if (
          companyId !== "all" &&
          String(p?.company_entity_id ?? "") !== companyId
        )
          return false;
        if (status !== "all" && w.status !== status) return false;
        if (q) {
          const hay = [
            p?.full_name,
            p?.username,
            w.game_name,
            w.bank_name,
            w.bank_account_number,
          ]
            .map(norm)
            .join(" ");
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [withdrawals, dateFrom, dateTo, companyId, status, q, playerById],
  );

  /** A game with no name yet — a recommend bonus CS has not credited. */
  const NO_GAME = "(no game yet)";

  /**
   * Every bonus payout in range, deposit and recommend alike, as plain data.
   *
   * Hoisted out of the table builder so the summary cards read the exact same
   * list: they used to recompute it independently, which is how a card and the
   * table under it can quietly disagree.
   */
  const bonusPayouts = useMemo(() => {
    if (def?.id !== "bonus_payout") return [];

    const withBonus =
      payoutKind === "Recommend"
        ? []
        : filteredDeposits.filter((d) => d.bonus_amount > 0);
    // Status holds *deposit* statuses; a recommend bonus can never satisfy one.
    // In recommend-only view the status filter simply does not apply, or a
    // leftover "completed" would empty the table and read as "no recommend
    // bonuses" rather than "that filter doesn't apply here".
    const showRecommend =
      (status === "all" || payoutKind === "Recommend") &&
      payoutKind !== "Deposit";
    const recommend = showRecommend ? filteredReferralBonuses : [];

    // One shape for two different payouts, so they sort and total together.
    // "Player" is who receives the money — the depositor for a deposit bonus,
    // the *upline* for a recommend bonus — which is the whole reason these
    // cannot be folded into the deposit's own figure.
    const rows: BonusPayout[] = [
      ...withBonus.map((d) => ({
        key: `dep-${d.deposit_id}`,
        date: d.deposit_date,
        kind: "Deposit" as const,
        ref: d.transaction_ref,
        playerId: d.player_id,
        player: playerLabelOf(d.player_id, d.player_username),
        company: companyNameOf(d.company_entity_id),
        game: d.selected_game || NO_GAME,
        status: d.status as BonusPayout["status"],
        pct: d.bonus_percentage,
        basis: d.deposit_amount,
        bonus: d.bonus_amount,
      })),
      ...recommend.map((b) => {
        const upline = playerById.get(b.upline_player_id);
        return {
          key: `rec-${b.bonus_id}`,
          // When the credit was handed over, or when it was earned if it is
          // still waiting for CS.
          date: b.assigned_at ?? b.created_at,
          kind: "Recommend" as const,
          ref: `REC-${b.bonus_id}`,
          // The upline is the one paid, so they are the "player" here.
          playerId: b.upline_player_id,
          player:
            upline?.full_name ?? upline?.username ?? `#${b.upline_player_id}`,
          company: companyNameOf(upline?.company_entity_id),
          // No game until CS credits it; lumping those under a real game would
          // misstate that game's spend.
          game: b.game_name || NO_GAME,
          status: b.status as BonusPayout["status"],
          pct: b.bonus_percentage,
          // The downline's qualifying deposit — the figure the percentage was
          // taken from, so the arithmetic on the row still reads.
          basis: b.deposit_amount,
          bonus: b.bonus_amount,
        };
      }),
    ];

    return rows
      .filter((p) => payoutKind === "all" || p.kind === payoutKind)
      .sort((a, b) => b.date.localeCompare(a.date));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    def,
    filteredDeposits,
    filteredReferralBonuses,
    status,
    payoutKind,
    playerById,
  ]);

  // Drop the drill when a filter moves: the game may no longer have any
  // payouts, and an empty table with no explanation reads as a bug. Derived
  // during render rather than in an effect, so it settles before paint.
  const drillKey = JSON.stringify([dateFrom, dateTo, companyId, status, payoutKind, q]);
  const [prevDrillKey, setPrevDrillKey] = useState(drillKey);
  if (drillKey !== prevDrillKey) {
    setPrevDrillKey(drillKey);
    if (drillGame !== null) setDrillGame(null);
  }

  /** The payouts actually on screen: one game's worth, or all of them. */
  const shownPayouts = useMemo(
    () =>
      drillGame === null
        ? bonusPayouts
        : bonusPayouts.filter((p) => p.game === drillGame),
    [bonusPayouts, drillGame],
  );

  const table: PreparedTable | null = useMemo(() => {
    if (!def) return null;

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
        const rows = filteredDeposits.map((d) => ({
          key: d.deposit_id,
          cells: [
            when(d.deposit_date),
            whenOrNever(d.approved_at),
            mono(d.transaction_ref),
            text(playerLabelOf(d.player_id, d.player_username)),
            text(companyNameOf(d.company_entity_id)),
            text(d.selected_game ?? "—"),
            badge(d.status),
            text(agentNameOf(d.handled_by_user_id)),
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
        const sum = (f: (d: (typeof filteredDeposits)[number]) => number) =>
          filteredDeposits.reduce((acc, d) => acc + f(d), 0);
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
          totals: [
            "Totals",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            formatRM(sum((d) => d.deposit_amount)),
            formatRM(sum((d) => d.bonus_amount)),
            formatRM(sum((d) => d.total_amount)),
          ],
        };
      }

      case "daily_withdrawals": {
        const rows = filteredWithdrawals.map((w) => {
          const p = playerById.get(w.player_id);
          return {
            key: w.withdrawal_id,
            cells: [
              when(w.created_at),
              mono(`WD-${w.withdrawal_id}`),
              text(p?.full_name ?? `#${w.player_id}`),
              text(companyNameOf(p?.company_entity_id)),
              text(w.game_name),
              text(
                w.bank_name
                  ? `${w.bank_name}${w.bank_account_number ? ` ${w.bank_account_number}` : ""}`
                  : "—",
              ),
              badge(w.status),
              text(agentNameOf(w.handled_by_user_id)),
              money(w.requested_amount),
              money(w.credit_pulled_amount),
            ],
          };
        });
        const sum = (f: (w: (typeof filteredWithdrawals)[number]) => number) =>
          filteredWithdrawals.reduce((acc, w) => acc + f(w), 0);
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
            "Totals",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            formatRM(sum((w) => w.requested_amount)),
            formatRM(sum((w) => w.credit_pulled_amount)),
          ],
        };
      }

      case "ggr_summary": {
        type Agg = {
          depCount: number;
          depVolume: number;
          bonus: number;
          wdCount: number;
          wdVolume: number;
        };
        const byCompany = new Map<number, Agg>();
        const aggOf = (id: number) => {
          let a = byCompany.get(id);
          if (!a) {
            a = { depCount: 0, depVolume: 0, bonus: 0, wdCount: 0, wdVolume: 0 };
            byCompany.set(id, a);
          }
          return a;
        };
        // Realised money only, matching the Dashboard's profit tile.
        //
        // This counted every non-failed row at its requested figure, which
        // booked unconfirmed deposits as revenue and, worse, booked a
        // withdrawal at what the player ASKED for rather than what was paid —
        // so a request of 100 settled at 30 overstated GGR's cost by 70, while
        // a `withdraw_all` (requested_amount = 0 until the agent reports back)
        // counted as nothing at all however much left the wallet.
        for (const d of filteredDeposits) {
          if (d.company_entity_id == null || d.status !== "completed") continue;
          const a = aggOf(d.company_entity_id);
          a.depCount += 1;
          a.depVolume += d.deposit_amount;
          a.bonus += d.bonus_amount;
        }
        for (const w of filteredWithdrawals) {
          if (w.status !== "paid") continue;
          const cid = playerById.get(w.player_id)?.company_entity_id;
          if (cid == null) continue;
          const a = aggOf(cid);
          a.wdCount += 1;
          a.wdVolume += w.credit_pulled_amount;
        }
        // Recommend bonuses are money out too, and are invisible here
        // otherwise: they are paid to the upline and never touch a deposit row.
        for (const b of filteredReferralBonuses) {
          if (b.status !== "assigned") continue;
          const cid = playerById.get(b.upline_player_id)?.company_entity_id;
          if (cid == null) continue;
          aggOf(cid).bonus += b.bonus_amount;
        }
        const entries = companies
          .map((c) => ({ company: c, agg: byCompany.get(c.company_id) }))
          .filter(
            (e): e is { company: (typeof companies)[number]; agg: Agg } =>
              e.agg !== undefined,
          );
        const ggrCell = (n: number): Cell => ({
          node: (
            <span
              className={cn(
                "font-medium",
                n >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
              )}
            >
              {formatRM(n)}
            </span>
          ),
          csv: n,
        });
        const rows = entries.map(({ company, agg }) => {
          const ggr = agg.depVolume - agg.wdVolume - agg.bonus;
          return {
            key: company.company_id,
            cells: [
              text(company.company_name),
              { node: agg.depCount, csv: agg.depCount },
              money(agg.depVolume),
              money(agg.bonus),
              { node: agg.wdCount, csv: agg.wdCount },
              money(agg.wdVolume),
              ggrCell(ggr),
            ],
          };
        });
        const t = entries.reduce(
          (acc, { agg }) => ({
            depCount: acc.depCount + agg.depCount,
            depVolume: acc.depVolume + agg.depVolume,
            bonus: acc.bonus + agg.bonus,
            wdCount: acc.wdCount + agg.wdCount,
            wdVolume: acc.wdVolume + agg.wdVolume,
          }),
          { depCount: 0, depVolume: 0, bonus: 0, wdCount: 0, wdVolume: 0 },
        );
        return {
          headers: [
            { label: "Company" },
            { label: "Deposits", align: "right" },
            { label: "Deposit Volume", align: "right" },
            { label: "Bonuses", align: "right" },
            { label: "Withdrawals", align: "right" },
            { label: "Withdrawal Volume", align: "right" },
            { label: "GGR", align: "right" },
          ],
          rows,
          totals: [
            "Totals",
            t.depCount,
            formatRM(t.depVolume),
            formatRM(t.bonus),
            t.wdCount,
            formatRM(t.wdVolume),
            formatRM(t.depVolume - t.wdVolume - t.bonus),
          ],
          summary:
            "Realised money only: completed deposits and paid withdrawals, at the amount actually paid. Bonuses include recommend bonuses credited to uplines.",
        };
      }

      case "cs_performance": {
        type Agg = {
          depCount: number;
          depVolume: number;
          wdCount: number;
          wdVolume: number;
        };
        const byUser = new Map<number, Agg>();
        const aggOf = (id: number) => {
          let a = byUser.get(id);
          if (!a) {
            a = { depCount: 0, depVolume: 0, wdCount: 0, wdVolume: 0 };
            byUser.set(id, a);
          }
          return a;
        };
        for (const d of filteredDeposits) {
          if (d.handled_by_user_id == null) continue;
          const a = aggOf(d.handled_by_user_id);
          a.depCount += 1;
          a.depVolume += d.total_amount;
        }
        for (const w of filteredWithdrawals) {
          if (w.handled_by_user_id == null) continue;
          const a = aggOf(w.handled_by_user_id);
          a.wdCount += 1;
          a.wdVolume += w.requested_amount;
        }
        const rows = [...byUser.entries()]
          .sort(
            ([, a], [, b]) =>
              b.depVolume + b.wdVolume - (a.depVolume + a.wdVolume),
          )
          .map(([userId, a]) => {
            const u = userById.get(userId);
            return {
              key: userId,
              cells: [
                {
                  node: (
                    <span>
                      <span className="font-medium">
                        {u?.full_name ?? `#${userId}`}
                      </span>
                      {u && (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">
                          @{u.username}
                        </span>
                      )}
                    </span>
                  ),
                  csv: u?.username ?? `#${userId}`,
                },
                { node: a.depCount, csv: a.depCount },
                money(a.depVolume),
                { node: a.wdCount, csv: a.wdCount },
                money(a.wdVolume),
                {
                  node: a.depCount + a.wdCount,
                  csv: a.depCount + a.wdCount,
                },
                money(a.depVolume + a.wdVolume),
              ],
            };
          });
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
          rows,
          summary:
            "Only transactions with a handling CS agent are counted.",
        };
      }

      case "bonus_payout": {
        const sum = (list: BonusPayout[], f: (p: BonusPayout) => number) =>
          list.reduce((acc, p) => acc + f(p), 0);

        // ---- Level 1: one row per game. Click a row to drill in. ----
        if (drillGame === null) {
          const byGame = new Map<string, BonusPayout[]>();
          for (const p of bonusPayouts) {
            const list = byGame.get(p.game);
            if (list) list.push(p);
            else byGame.set(p.game, [p]);
          }

          // Biggest bonus spend first: the top row is the one worth opening.
          // Games come from the payouts themselves, not the catalogue, so a
          // game with no bonuses this period is absent rather than a zero row.
          const groups = [...byGame.entries()]
            .map(([game, list]) => ({
              game,
              list,
              bonus: sum(list, (p) => p.bonus),
              basis: sum(list, (p) => p.basis),
              deposit: list.filter((p) => p.kind === "Deposit").length,
              recommend: list.filter((p) => p.kind === "Recommend").length,
            }))
            .sort((a, b) => b.bonus - a.bonus);

          return {
            headers: [
              { label: "Game" },
              { label: "Payouts", align: "right" },
              { label: "Deposit bonuses", align: "right" },
              { label: "Recommend bonuses", align: "right" },
              { label: "Deposit Volume", align: "right" },
              { label: "Bonus Paid", align: "right" },
            ],
            rows: groups.map((g) => ({
              key: `game-${g.game}`,
              onClick: () => setDrillGame(g.game),
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
                { node: g.list.length, csv: g.list.length },
                { node: g.deposit, csv: g.deposit },
                { node: g.recommend, csv: g.recommend },
                { node: formatRM(g.basis), csv: g.basis },
                { node: formatRM(g.bonus), csv: g.bonus },
              ],
            })),
            totals: [
              "Totals",
              bonusPayouts.length,
              bonusPayouts.filter((p) => p.kind === "Deposit").length,
              bonusPayouts.filter((p) => p.kind === "Recommend").length,
              formatRM(sum(bonusPayouts, (p) => p.basis)),
              formatRM(sum(bonusPayouts, (p) => p.bonus)),
            ],
            summary:
              "Click a game to see its payouts. Deposits with no bonus are excluded; cancelled recommend bonuses are written off and excluded.",
          };
        }

        // ---- Level 2: one game's payouts. ----
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
          rows: shownPayouts.map((p) => ({
            key: p.key,
            cells: [
              when(p.date),
              {
                node: (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                      p.kind === "Recommend"
                        ? "bg-purple-500/10 text-purple-700 dark:text-purple-300"
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
          totals: [
            "Totals",
            null,
            null,
            null,
            null,
            null,
            null,
            formatRM(sum(shownPayouts, (p) => p.basis)),
            formatRM(sum(shownPayouts, (p) => p.bonus)),
          ],
          summary: `Bonus payouts for ${drillGame}.`,
        };
      }

      case "bank_reconciliation": {
        const flagOf = (
          d: (typeof filteredDeposits)[number],
        ): { label: string; ok: boolean } => {
          if (d.status === "failed") return { label: "Failed", ok: false };
          if (d.status === "pending_match")
            return { label: "Unmatched", ok: false };
          if (d.status === "completed" && !d.game_topup_reference)
            return { label: "No top-up ref", ok: false };
          return { label: "OK", ok: true };
        };
        const rows = filteredDeposits.map((d) => {
          const flag = flagOf(d);
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
                      flag.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {flag.ok ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <AlertTriangle className="h-3 w-3" />
                    )}
                    {flag.label}
                  </span>
                ),
                csv: flag.label,
              },
            ],
          };
        });
        const issues = filteredDeposits.filter((d) => !flagOf(d).ok).length;
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
          summary:
            issues === 0
              ? "No discrepancies in this period."
              : `${issues} discrepanc${issues === 1 ? "y" : "ies"} flagged.`,
        };
      }

      default:
        return null;
    }
    // playerLabelOf/companyNameOf/agentNameOf are stable derivations of the
    // deps already listed, so they are intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    def,
    filteredDeposits,
    filteredWithdrawals,
    bonusPayouts,
    shownPayouts,
    drillGame,
    companies,
    playerById,
    userById,
  ]);

  // Summary tiles shown above the table for the transaction-style reports.
  const summaryTiles: {
    title: string;
    value: string;
    sub?: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = useMemo(() => {
    const uniquePlayers = (ids: (number | null)[]) =>
      new Set(ids.filter((x): x is number => x != null)).size;
    if (!def) return [];
    switch (def.id) {
      case "daily_deposits": {
        const total = filteredDeposits.reduce((s, d) => s + d.deposit_amount, 0);
        return [
          { title: "Total Deposit Amount", value: formatRM(total), icon: Wallet },
          {
            title: "Unique Players",
            value: String(uniquePlayers(filteredDeposits.map((d) => d.player_id))),
            sub: "deposited in this period",
            icon: Users,
          },
          {
            title: "Transactions",
            value: filteredDeposits.length.toLocaleString(),
            icon: Hash,
          },
        ];
      }
      case "daily_withdrawals": {
        const total = filteredWithdrawals.reduce(
          (s, w) => s + w.requested_amount,
          0,
        );
        return [
          { title: "Total Withdrawal Amount", value: formatRM(total), icon: Wallet },
          {
            title: "Unique Players",
            value: String(
              uniquePlayers(filteredWithdrawals.map((w) => w.player_id)),
            ),
            sub: "withdrew in this period",
            icon: Users,
          },
          {
            title: "Transactions",
            value: filteredWithdrawals.length.toLocaleString(),
            icon: Hash,
          },
        ];
      }
      case "bonus_payout": {
        // Reads the same list the table does, scoped the same way — so drilling
        // into a game moves the cards with it, and a card can never quietly
        // disagree with the rows underneath it.
        const shown = shownPayouts;
        const dep = shown.filter((p) => p.kind === "Deposit");
        const rec = shown.filter((p) => p.kind === "Recommend");
        const depTotal = dep.reduce((a, p) => a + p.bonus, 0);
        const recTotal = rec.reduce((a, p) => a + p.bonus, 0);
        const scope = drillGame ? ` · ${drillGame}` : "";
        return [
          {
            title: "Total Bonus Amount",
            value: formatRM(depTotal + recTotal),
            sub: `${formatRM(depTotal)} deposit · ${formatRM(recTotal)} recommend${scope}`,
            icon: Gift,
          },
          {
            title: "Unique Players",
            value: String(uniquePlayers(shown.map((p) => p.playerId))),
            sub: "claimed a bonus",
            icon: Users,
          },
          {
            title: drillGame ? "Payouts" : "Bonus Transactions",
            value: shown.length.toLocaleString(),
            sub: `${dep.length} deposit · ${rec.length} recommend`,
            icon: Hash,
          },
        ];
      }
      default:
        return [];
    }
  }, [def, filteredDeposits, filteredWithdrawals, shownPayouts, drillGame]);

  if (!def || !table) {
    return (
      <div className="space-y-4">
        <Link
          href="/reports"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to reports
        </Link>
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

  function exportCsv() {
    if (!table || !def) return;
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      table.headers.map((h) => esc(h.label)).join(","),
      // Exports exactly what is on screen — the game summary, or one game's
      // payouts once drilled in.
      ...table.rows.map((r) => r.cells.map((c) => esc(c.csv)).join(",")),
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
    toast.success(`Exported ${table.rows.length} rows to CSV`);
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/reports"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to reports
        </Link>
        <div className="mt-3 flex items-start justify-between gap-3">
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
                {drillGame && (
                  <span className="text-muted-foreground"> · {drillGame}</span>
                )}
              </h1>
              {drillGame ? (
                // A way back out. Without it the only route to the summary is a
                // full page reload, since the drill lives in component state.
                <button
                  onClick={() => setDrillGame(null)}
                  className="mt-0.5 inline-flex cursor-pointer items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  All games
                </button>
              ) : (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {def.description}
                </p>
              )}
            </div>
          </div>
          <Button onClick={exportCsv} className="shrink-0 cursor-pointer">
            <Download className="h-3.5 w-3.5" />
            Export CSV
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
                  <SelectItem value="Recommend" className="cursor-pointer">
                    Recommend bonus
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Hidden in recommend-only view: these are deposit statuses, and a
              recommend bonus has its own (pending/assigned/cancelled). */}
          {statusOptions && payoutKind !== "Recommend" && (
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {summaryTiles.map((t) => (
            <StatTile
              key={t.title}
              title={t.title}
              value={t.value}
              sub={t.sub}
              icon={t.icon}
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
                    {!hydrated ? (
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
      </Card>
    </div>
  );
}

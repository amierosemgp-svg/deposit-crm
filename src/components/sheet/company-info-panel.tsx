"use client";

/**
 * The block the client keeps at the top of every sheet in their workbook:
 * what moved through the banks, game/kiosk credits, and the period's net —
 * always visible while rows scroll underneath. Each account shows the money
 * that moved through it with its balance alongside, so "how busy was this
 * account" and "can it cover the next payout" are answered together.
 *
 * The two bank cards are money IN and money OUT, not "deposit accounts" and
 * "withdrawal accounts". Every account at this operator is role `both`, so
 * splitting by role printed the same list twice — and printed the balance
 * where the flow belonged. The account named "HLB Payout" has taken deposits
 * and paid no withdrawals; the role simply does not describe what an account
 * does. See /api/bank-movements, which asks the transactions instead.
 *
 * Presented as the dashboard's cards (same Card chrome, uppercase muted
 * titles, figure + bordered account list) so the sheet page and the dashboard
 * read as one product. Kiosk credits still come from the store; the bank
 * figures are aggregated server-side because the store holds only the most
 * recent few hundred deposits.
 */

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { rangeLabel, type DateRange } from "@/lib/date-range";
import { formatRM, isBotOnline } from "@/lib/format";
import { botForName } from "@/lib/bot-category";
import { byBankOrder } from "@/lib/bank-order";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Banknote, Coins, Landmark, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BANK_MOVEMENT_LABEL,
  type BankMovementSource,
  type BankMovements,
} from "@/lib/types";

/**
 * The order the client's own workbook lists kiosks in.
 *
 * Deliberately fixed rather than alphabetical or by id: the desk reads this
 * card against a spreadsheet they have used for years, and a row in a
 * different place is a row they have to hunt for.
 *
 * Each entry holds every spelling that means the same kiosk, because the
 * sheet and the CRM don't always agree (Joker123 / Joker, LuckyPalace /
 * LPE88). Matching ignores case and punctuation. A kiosk matching nothing
 * here still shows — it sorts to the bottom, alphabetically — so a spelling
 * nobody anticipated is visible and easy to fix rather than silently gone.
 */
const KIOSK_ORDER: readonly (readonly string[])[] = [
  ["rollex", "rollex11"],
  ["scr888"],
  ["suncity"],
  ["luckypalace", "lpe88"],
  ["3win8"],
  ["ace333"],
  ["mega888"],
  ["sky777"],
  ["joker123", "joker"],
  ["xe88"],
  ["scr918kiss", "918kiss"],
  ["ac", "allcity"],
  ["918kaya", "kaya"],
  ["pussy888"],
  ["4d"],
];

/** "Joker 123" and "joker123" are the same kiosk. */
function kioskKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const KIOSK_RANK = new Map<string, number>(
  KIOSK_ORDER.flatMap((names, i) => names.map((n) => [n, i] as const)),
);

/** Where a kiosk sits in the workbook's order; unknown ones go last. */
function kioskRank(gameName: string): number {
  return KIOSK_RANK.get(kioskKey(gameName)) ?? Number.MAX_SAFE_INTEGER;
}

function InfoCard({
  title,
  hint,
  icon: Icon,
  total,
  rows,
  totalClassName,
}: {
  title: string;
  /** Small note beside the title — what period the row counts cover. */
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  total: number;
  rows: {
    label: string;
    value: number;
    dim?: boolean;
    online?: boolean;
    /** Transactions in the period, shown next to the name ("10 dep"). */
    count?: number;
    countSuffix?: string;
    /**
     * A quieter second figure under the name — the account's balance, read
     * beneath the money that moved through it. The desk needs both at once:
     * the flow answers "how much went through here this month", the balance
     * answers "can I pay the next withdrawal out of it".
     */
    note?: string;
  }[];
  totalClassName?: string;
}) {
  return (
    <Card size="sm" className="gap-1.5">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
        <CardTitle className="flex min-w-0 items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <span className="truncate">{title}</span>
          {hint && (
            <span className="shrink-0 normal-case tracking-normal text-muted-foreground/70">
              {hint}
            </span>
          )}
        </CardTitle>
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </CardHeader>
      <CardContent className="px-3">
        <div className={cn("text-sm font-semibold tabular-nums", totalClassName)}>
          {formatRM(total)}
        </div>
        <div className="mt-1.5 max-h-20 space-y-0.5 overflow-y-auto border-t pt-1.5">
          {rows.length === 0 && (
            <p className="text-[11px] text-muted-foreground">Nothing yet.</p>
          )}
          {rows.map((r, i) => (
            <div
              key={`${r.label}-${i}`}
              className="flex items-baseline justify-between gap-2 text-[12px]"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {r.online !== undefined && (
                  <span
                    title={r.online ? "Agent online" : "Agent offline"}
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      r.online ? "bg-emerald-500" : "bg-red-500",
                    )}
                  />
                )}
                <span className={cn("truncate", r.dim && "text-muted-foreground")}>
                  {r.label}
                </span>
                {r.count !== undefined && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                    {r.count} {r.countSuffix ?? ""}
                  </span>
                )}
                {r.note && (
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">
                    {r.note}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap font-medium tabular-nums",
                  r.dim && "text-muted-foreground",
                  r.value < 0 && "text-red-600 dark:text-red-400",
                )}
              >
                {formatRM(r.value)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function CompanyInfoPanel({ range }: { range: DateRange }) {
  const boAccounts = useStore((s) => s.boAccounts);
  const botHealth = useStore((s) => s.botHealth);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const companyInScope = useStore((s) => s.companyInScope);
  const loadBankMovements = useStore((s) => s.loadBankMovements);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const bankAccounts = useStore((s) => s.bankAccounts);
  // Re-reads whenever anything else on the page does — see store.dataVersion.
  const dataVersion = useStore((s) => s.dataVersion);

  /**
   * Bank figures come from the server, not from the store.
   *
   * They used to be computed here out of `deposits`, which /api/state caps at
   * the most recent 500 rows — so a card claiming to cover the month was
   * really covering the last day or two, and said "33 dep" where the real
   * figure was 1,393. Anything totalled across a period has to be totalled
   * where every row is.
   */
  const [movements, setMovements] = useState<BankMovements>({
    accounts: [],
    totals: [],
  });
  useEffect(() => {
    let live = true;
    void loadBankMovements({
      from: range.from,
      to: range.to,
      companyId: selectedCompanyId,
    }).then((m) => {
      if (live) setMovements(m);
    });
    return () => {
      live = false;
    };
    // selectedLeaderId narrows which companies count, through companyInScope;
    // dataVersion is what makes a saved or deleted row show up here at once
    // rather than on the next page load.
  }, [
    loadBankMovements,
    range.from,
    range.to,
    selectedCompanyId,
    selectedLeaderId,
    dataVersion,
  ]);

  const scope = useMemo(() => {
    /**
     * Money in and money out, per account, over the period.
     *
     * Not "deposit accounts" and "withdrawal accounts": every account here is
     * role `both`, and the account named "HLB Payout" has taken deposits and
     * paid no withdrawals, so the role says nothing about what an account
     * does. An account appears on whichever card it actually moved money on.
     *
     * The balance rides along beside the flow — the flow says how busy the
     * account was, the balance says whether it can cover the next payout.
     */
    const visible = movements.accounts
      .filter((m) => companyInScope(m.entity_id))
      .map((m) => {
        const account = bankAccounts.find((a) => a.account_id === m.account_id);
        return {
          ...m,
          name: m.label || m.bank_name,
          online: isBotOnline(botForName(botHealth, m.bank_name)?.last_heartbeat_at),
          sortKey: account,
        };
      });
    const ordered = [...visible].sort((a, b) =>
      a.sortKey && b.sortKey
        ? byBankOrder(a.sortKey, b.sortKey)
        : a.name.localeCompare(b.name),
    );

    const row = (m: (typeof ordered)[number], dir: "in" | "out") => ({
      label: m.name,
      value: dir === "in" ? m.in_amount : m.out_amount,
      count: dir === "in" ? m.in_count : m.out_count,
      countSuffix: dir,
      note: `bal ${formatRM(m.balance)}`,
      online: m.online,
    });

    // A card lists the accounts that actually moved money that way. An account
    // that took nothing in is noise on the "in" card, not information.
    const banksIn = ordered.filter((m) => m.in_count > 0).map((m) => row(m, "in"));
    const banksOut = ordered.filter((m) => m.out_count > 0).map((m) => row(m, "out"));

    const totalIn = visible.reduce((a, m) => a + m.in_amount, 0);
    const totalOut = visible.reduce((a, m) => a + m.out_amount, 0);

    /**
     * The period's breakdown, in the order the desk thinks about it: what came
     * in, then each way it went out. Clear Bank is about a third of the money
     * leaving the banks and expenses are real too — a net that counted only
     * withdrawals understated the outflow by roughly a quarter.
     */
    const bySource = new Map<string, { amount: number; count: number; bonus: number }>();
    for (const t of movements.totals) {
      const key = `${t.source}:${t.direction}`;
      const at = bySource.get(key) ?? { amount: 0, count: 0, bonus: 0 };
      bySource.set(key, {
        amount: at.amount + t.amount,
        count: at.count + t.count,
        bonus: at.bonus + t.bonus,
      });
    }
    const of = (source: BankMovementSource, direction: "in" | "out") =>
      bySource.get(`${source}:${direction}`) ?? { amount: 0, count: 0, bonus: 0 };

    const deposits = of("deposit", "in");
    const netRows: {
      label: string;
      value: number;
      dim?: boolean;
    }[] = [
      { label: `Deposits (${deposits.count})`, value: deposits.amount },
      { label: "Bonus given", value: deposits.bonus, dim: true },
    ];
    for (const source of [
      "withdrawal",
      "clear_bank",
      "expense",
      "leader_transfer",
      "bank_transfer",
    ] as const) {
      const out = of(source, "out");
      const inward = of(source, "in");
      // A source nobody used this period is left off rather than shown as zero.
      if (out.count > 0) {
        netRows.push({
          label: `${BANK_MOVEMENT_LABEL[source]} (${out.count})`,
          value: -out.amount,
        });
      }
      if (inward.count > 0) {
        netRows.push({
          label: `${BANK_MOVEMENT_LABEL[source]} in (${inward.count})`,
          value: inward.amount,
        });
      }
    }

    const activeKiosks = boAccounts.filter(
      (b) => b.status === "active" && companyInScope(b.company_entity_id),
    );
    // Rows are named after the game, so they read like the workbook. When a
    // game runs more than one back-office the name alone doesn't say which,
    // and only those rows carry their account label as well.
    const kiosksPerGame = new Map<string, number>();
    for (const b of activeKiosks) {
      const key = kioskKey(b.game_name);
      kiosksPerGame.set(key, (kiosksPerGame.get(key) ?? 0) + 1);
    }
    const games = activeKiosks
      .map((b) => ({
        label:
          (kiosksPerGame.get(kioskKey(b.game_name)) ?? 0) > 1 && b.bo_label
            ? `${b.game_name} · ${b.bo_label}`
            : b.game_name,
        value: b.current_credit,
        online: isBotOnline(botForName(botHealth, b.game_name)?.last_heartbeat_at),
        rank: kioskRank(b.game_name),
      }))
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));

    return { banksIn, banksOut, totalIn, totalOut, netRows, games };
  }, [movements, bankAccounts, boAccounts, botHealth, companyInScope]);

  const monthLabel = rangeLabel(range);
  const net = scope.totalIn - scope.totalOut;

  return (
    <div className="grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4">
      <InfoCard
        title="Bank · Money In"
        hint={monthLabel}
        icon={Landmark}
        total={scope.totalIn}
        rows={scope.banksIn}
      />
      <InfoCard
        title="Bank · Money Out"
        hint={monthLabel}
        icon={Banknote}
        total={scope.totalOut}
        rows={scope.banksOut}
      />
      <InfoCard
        title="Game · Kiosk Credit"
        icon={Coins}
        total={scope.games.reduce((a, r) => a + r.value, 0)}
        rows={scope.games}
      />
      <InfoCard
        title={`${monthLabel} · Net`}
        icon={Wallet}
        total={net}
        totalClassName={net < 0 ? "text-red-600 dark:text-red-400" : undefined}
        rows={scope.netRows}
      />
    </div>
  );
}

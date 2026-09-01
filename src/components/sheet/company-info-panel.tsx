"use client";

/**
 * The block the client keeps at the top of every sheet in their workbook:
 * bank balances, game/kiosk credits, and the running month totals — always
 * visible while rows scroll underneath.
 *
 * Presented as the dashboard's cards (same Card chrome, uppercase muted
 * titles, figure + bordered account list) so the sheet page and the dashboard
 * read as one product. Sourced live: bank balances from the accounts the
 * agent heartbeats, game credits from the kiosk back-offices, totals from the
 * month's deposits/withdrawals in the CRM.
 */

import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { formatRM, isOnline } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Banknote, Coins, Landmark, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

function InfoCard({
  title,
  icon: Icon,
  total,
  rows,
  totalClassName,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  total: number;
  rows: { label: string; value: number; dim?: boolean; online?: boolean }[];
  totalClassName?: string;
}) {
  return (
    <Card size="sm" className="gap-1.5">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
        <CardTitle className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
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
              className="flex items-center justify-between gap-2 text-[12px]"
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

export function CompanyInfoPanel({ month }: { month: string | "all" }) {
  const bankAccounts = useStore((s) => s.bankAccounts);
  const boAccounts = useStore((s) => s.boAccounts);
  const deposits = useStore((s) => s.deposits);
  const withdrawals = useStore((s) => s.withdrawals);
  const players = useStore((s) => s.players);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const companyInScope = useStore((s) => s.companyInScope);
  useStore((s) => s.selectedLeaderId);

  const inMonth = (iso: string) => month === "all" || iso.slice(0, 7) === month;

  const scope = useMemo(() => {
    const banksDeposit = bankAccounts
      .filter((a) => a.status === "active" && a.role === "deposit" && companyInScope(a.entity_id))
      .map((a) => ({
        label: a.label || `${a.bank_name}`,
        value: a.current_balance,
        online: isOnline(a.last_heartbeat_at),
      }));
    const banksWithdrawal = bankAccounts
      .filter((a) => a.status === "active" && a.role === "withdrawal" && companyInScope(a.entity_id))
      .map((a) => ({
        label: a.label || `${a.bank_name}`,
        value: a.current_balance,
        online: isOnline(a.last_heartbeat_at),
      }));
    const games = boAccounts
      .filter((b) => b.status === "active" && companyInScope(b.company_entity_id))
      .map((b) => ({
        label: b.bo_label || b.game_name,
        value: b.current_credit,
        online: isOnline(b.last_heartbeat_at),
      }));

    let depTotal = 0;
    let depBonus = 0;
    let depCount = 0;
    for (const d of deposits) {
      if (!companyInScope(d.company_entity_id) && d.company_entity_id !== null) continue;
      if (!inMonth(d.deposit_date)) continue;
      if (d.status === "failed") continue;
      depTotal += d.deposit_amount;
      depBonus += d.bonus_amount;
      depCount++;
    }
    // Withdrawals carry no company of their own — scope through the player.
    const playerCompany = new Map(players.map((p) => [p.player_id, p.company_entity_id]));
    let wdTotal = 0;
    let wdCount = 0;
    for (const w of withdrawals) {
      if (w.status === "failed") continue;
      if (!inMonth(w.created_at)) continue;
      if (!companyInScope(playerCompany.get(w.player_id) ?? null)) continue;
      wdTotal += w.status === "paid" ? w.credit_pulled_amount || w.requested_amount : w.requested_amount;
      wdCount++;
    }
    return { banksDeposit, banksWithdrawal, games, depTotal, depBonus, depCount, wdTotal, wdCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bankAccounts, boAccounts, deposits, withdrawals, players, month, selectedCompanyId, companyInScope]);

  const monthLabel =
    month === "all"
      ? "All time"
      : new Date(`${month}-01T00:00:00`).toLocaleString("en-US", {
          month: "long",
          year: "numeric",
        });

  const sum = (rows: { value: number }[]) => rows.reduce((a, r) => a + r.value, 0);
  const net = scope.depTotal - scope.wdTotal;

  return (
    <div className="grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4">
      <InfoCard
        title="Bank · Deposit"
        icon={Landmark}
        total={sum(scope.banksDeposit)}
        rows={scope.banksDeposit}
      />
      <InfoCard
        title="Bank · Withdrawal"
        icon={Banknote}
        total={sum(scope.banksWithdrawal)}
        rows={scope.banksWithdrawal}
      />
      <InfoCard
        title="Game · Kiosk Credit"
        icon={Coins}
        total={sum(scope.games)}
        rows={scope.games}
      />
      <InfoCard
        title={`${monthLabel} · Net`}
        icon={Wallet}
        total={net}
        totalClassName={net < 0 ? "text-red-600 dark:text-red-400" : undefined}
        rows={[
          { label: `Deposits (${scope.depCount})`, value: scope.depTotal },
          { label: "Bonus given", value: scope.depBonus, dim: true },
          { label: `Withdrawals (${scope.wdCount})`, value: scope.wdTotal },
        ]}
      />
    </div>
  );
}

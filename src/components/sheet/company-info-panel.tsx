"use client";

/**
 * The block the client keeps at the top of every sheet in their workbook:
 * bank balances on the left, game/kiosk credits next to them, and the running
 * month totals — always visible while rows scroll underneath.
 *
 * Same information, same position, sourced live: bank balances from the
 * accounts the agent heartbeats, game credits from the kiosk back-offices,
 * totals from this month's deposits/withdrawals in the CRM.
 */

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";

function fmt(n: number): string {
  return n.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function MiniTable({
  title,
  rows,
  total,
  tone = "emerald",
}: {
  title: string;
  rows: { label: string; value: number; dim?: boolean }[];
  total?: number;
  tone?: "emerald" | "sky" | "amber";
}) {
  const header = {
    emerald: "bg-emerald-700 dark:bg-emerald-800",
    sky: "bg-sky-700 dark:bg-sky-800",
    amber: "bg-amber-600 dark:bg-amber-700",
  }[tone];
  return (
    <table className="h-fit shrink-0 border-collapse text-[12px]">
      <thead>
        <tr>
          <th
            colSpan={2}
            className={cn(
              "border border-border px-2 py-0.5 text-left font-semibold text-white",
              header,
            )}
          >
            {title}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td className="border border-border px-2 py-0.5 italic text-muted-foreground" colSpan={2}>
              none
            </td>
          </tr>
        )}
        {rows.map((r, i) => (
          <tr key={`${r.label}-${i}`}>
            <td
              className={cn(
                "border border-border bg-background px-2 py-0.5",
                r.dim && "text-muted-foreground",
              )}
            >
              {r.label}
            </td>
            <td
              className={cn(
                "border border-border bg-background px-2 py-0.5 text-right tabular-nums",
                r.value < 0 && "text-red-600 dark:text-red-400",
                r.dim && "text-muted-foreground",
              )}
            >
              {fmt(r.value)}
            </td>
          </tr>
        ))}
        {total !== undefined && (
          <tr>
            <td className="border border-border bg-muted px-2 py-0.5 font-semibold">Total</td>
            <td
              className={cn(
                "border border-border bg-muted px-2 py-0.5 text-right font-semibold tabular-nums",
                total < 0 && "text-red-600 dark:text-red-400",
              )}
            >
              {fmt(total)}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function CompanyInfoPanel({ month }: { month: string | "all" }) {
  const bankAccounts = useStore((s) => s.bankAccounts);
  const boAccounts = useStore((s) => s.boAccounts);
  const deposits = useStore((s) => s.deposits);
  const withdrawals = useStore((s) => s.withdrawals);
  const players = useStore((s) => s.players);
  const entities = useStore((s) => s.entities);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const companyInScope = useStore((s) => s.companyInScope);
  useStore((s) => s.selectedLeaderId);

  const [open, setOpen] = useState(true);

  const inMonth = (iso: string) => month === "all" || iso.slice(0, 7) === month;

  const scope = useMemo(() => {
    const banksDeposit = bankAccounts
      .filter((a) => a.status === "active" && a.role === "deposit" && companyInScope(a.entity_id))
      .map((a) => ({ label: a.label || `${a.bank_name}`, value: a.current_balance }));
    const banksWithdrawal = bankAccounts
      .filter((a) => a.status === "active" && a.role === "withdrawal" && companyInScope(a.entity_id))
      .map((a) => ({ label: a.label || `${a.bank_name}`, value: a.current_balance }));
    const games = boAccounts
      .filter((b) => b.status === "active" && companyInScope(b.company_entity_id))
      .map((b) => ({ label: b.bo_label || b.game_name, value: b.current_credit }));

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

  const companyName = useMemo(() => {
    if (selectedCompanyId !== null) {
      return entities.find((e) => e.entity_id === selectedCompanyId)?.name ?? "Company";
    }
    return entities.find((e) => e.entity_type === "main_company")?.name ?? "All companies";
  }, [entities, selectedCompanyId]);

  const monthLabel =
    month === "all"
      ? "All time"
      : new Date(`${month}-01T00:00:00`).toLocaleString("en-US", {
          month: "long",
          year: "numeric",
        });

  const sum = (rows: { value: number }[]) => rows.reduce((a, r) => a + r.value, 0);

  return (
    <div className="shrink-0 overflow-hidden rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between bg-emerald-700 px-3 py-1.5 text-left text-white dark:bg-emerald-800"
      >
        <span className="text-sm font-bold tracking-wide">
          {companyName}
          <span className="ml-2 font-normal text-emerald-100/90">· {monthLabel}</span>
        </span>
        <span className="flex items-center gap-3 text-[12px] tabular-nums">
          <span>
            IN <b>{fmt(scope.depTotal)}</b>
          </span>
          <span>
            OUT <b>{fmt(scope.wdTotal)}</b>
          </span>
          <span className={cn(scope.depTotal - scope.wdTotal < 0 && "text-red-300")}>
            NET <b>{fmt(scope.depTotal - scope.wdTotal)}</b>
          </span>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </span>
      </button>
      {open && (
        <div className="flex items-start gap-3 overflow-x-auto bg-muted/30 p-2">
          <MiniTable
            title="BANK · Deposit"
            rows={scope.banksDeposit}
            total={sum(scope.banksDeposit)}
          />
          <MiniTable
            title="BANK · Withdrawal"
            rows={scope.banksWithdrawal}
            total={sum(scope.banksWithdrawal)}
            tone="sky"
          />
          <MiniTable title="GAME (kiosk credit)" rows={scope.games} total={sum(scope.games)} tone="amber" />
          <MiniTable
            title={`${monthLabel} summary`}
            rows={[
              { label: `Deposits (${scope.depCount})`, value: scope.depTotal },
              { label: "Bonus given", value: scope.depBonus, dim: true },
              { label: `Withdrawals (${scope.wdCount})`, value: scope.wdTotal },
              { label: "Net", value: scope.depTotal - scope.wdTotal },
            ]}
          />
        </div>
      )}
    </div>
  );
}

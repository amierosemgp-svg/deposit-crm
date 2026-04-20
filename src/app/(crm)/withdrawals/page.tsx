"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { PLAYERS } from "@/lib/mock-data";
import { formatRM, formatDateTime, formatRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { PlayerNameLink } from "@/components/player-name-link";
import { PullbackFlowModal } from "@/components/pullback-flow-modal";
import { ArrowDownToLine, Banknote, CheckCircle2 } from "lucide-react";

export default function WithdrawalsPage() {
  const withdrawals = useStore((s) => s.withdrawals);
  const getBalance = useStore((s) => s.getCreditBalance);
  const markPaid = useStore((s) => s.markWithdrawalPaid);
  const [pullingId, setPullingId] = useState<number | null>(null);

  const sorted = useMemo(
    () =>
      [...withdrawals].sort((a, b) => {
        // requested first, then credits_pulled, then paid, then failed
        const rank = (s: string) =>
          s === "requested"
            ? 0
            : s === "credits_pulled"
              ? 1
              : s === "paid"
                ? 2
                : 3;
        const d = rank(a.status) - rank(b.status);
        if (d !== 0) return d;
        return b.created_at.localeCompare(a.created_at);
      }),
    [withdrawals],
  );

  const pending = withdrawals.filter(
    (w) => w.status === "requested" || w.status === "credits_pulled",
  ).length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Withdrawals</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Requests received via Telegram/WeChat — pull credits from game, then pay out
          </p>
        </div>
        {pending > 0 && (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700">
            {pending} awaiting action
          </div>
        )}
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Requested</th>
                <th className="px-3 py-2.5 text-left font-medium">Player</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Requested Amt</th>
                <th className="px-3 py-2.5 text-left font-medium">Game</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Current Balance</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Pulled</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((w) => {
                const player = PLAYERS.find((p) => p.player_id === w.player_id);
                const bal = getBalance(w.player_id, w.game_name);
                const canPull = w.status === "requested";
                const canPay = w.status === "credits_pulled";
                return (
                  <tr key={w.withdrawal_id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-[12px]">{formatDateTime(w.created_at)}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {formatRelative(w.created_at)}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <PlayerNameLink playerId={w.player_id}>
                        {player?.username ?? `P-${w.player_id}`}
                      </PlayerNameLink>
                      <div className="text-[10px] text-muted-foreground">
                        {player?.telegram_username}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                      {formatRM(w.requested_amount)}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center rounded-md border bg-card px-1.5 py-0.5 text-[11px]">
                        {w.game_name}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-muted-foreground">
                      {formatRM(bal)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {w.credit_pulled_amount > 0
                        ? formatRM(w.credit_pulled_amount)
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={w.status} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canPull && (
                        <Button
                          size="sm"
                          onClick={() => setPullingId(w.withdrawal_id)}
                          className="bg-blue-600 text-white hover:bg-blue-700"
                        >
                          <ArrowDownToLine className="h-3.5 w-3.5" />
                          Pull Credits
                        </Button>
                      )}
                      {canPay && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => markPaid(w.withdrawal_id)}
                        >
                          <Banknote className="h-3.5 w-3.5" />
                          Mark Paid
                        </Button>
                      )}
                      {w.status === "paid" && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Sent
                        </span>
                      )}
                      {w.status === "failed" && (
                        <span className="text-[11px] text-red-600">Failed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
          <span>
            {sorted.length} total — pay-out step is manual bank transfer (Option 4 would automate this)
          </span>
        </div>
      </Card>

      <PullbackFlowModal
        withdrawalId={pullingId}
        open={pullingId !== null}
        onOpenChange={(o) => !o && setPullingId(null)}
      />
    </div>
  );
}

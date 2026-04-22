"use client";

import { useStore } from "@/lib/store";
import { PLAYERS, COMPANIES } from "@/lib/mock-data";
import { formatRM, formatShortDateTime, formatRelative, initialsOf } from "@/lib/format";
import { GAMES } from "@/lib/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusBadge } from "./status-badge";
import { Separator } from "@/components/ui/separator";
import { Send, MessageCircle, Phone, Calendar, Landmark } from "lucide-react";

type Props = {
  playerId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PlayerProfileSheet({ playerId, open, onOpenChange }: Props) {
  const importedPlayers = useStore((s) => s.importedPlayers);
  const player =
    importedPlayers.find((p) => p.player_id === playerId) ??
    PLAYERS.find((p) => p.player_id === playerId);
  const gameCredits = useStore((s) => s.gameCredits);
  const deposits = useStore((s) => s.deposits);
  const withdrawals = useStore((s) => s.withdrawals);

  const playerCredits = gameCredits.filter((c) => c.player_id === playerId);
  const playerDeposits = deposits
    .filter((d) => d.player_id === playerId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8);
  const playerWithdrawals = withdrawals
    .filter((w) => w.player_id === playerId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8);

  const company = player
    ? COMPANIES.find((c) => c.company_id === player.company_id)
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto p-0 gap-0">
        {player && (
          <>
            <SheetHeader className="border-b p-6 pb-4 space-y-0">
              <div className="flex items-start gap-4">
                <Avatar className="h-14 w-14 ring-2 ring-primary/10">
                  <AvatarFallback className="text-base font-semibold">
                    {initialsOf(player.full_name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-lg flex items-center gap-2">
                    {player.full_name}
                    <StatusBadge status={player.status} />
                  </SheetTitle>
                  <SheetDescription className="mt-0.5">
                    @{player.username} · Player ID P-{player.player_id}
                  </SheetDescription>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Send className="h-3 w-3" />
                      {player.telegram_username}
                    </span>
                    {player.wechat_id && (
                      <span className="inline-flex items-center gap-1.5">
                        <MessageCircle className="h-3 w-3" />
                        {player.wechat_id}
                      </span>
                    )}
                    {player.contact_number && (
                      <span className="inline-flex items-center gap-1.5">
                        <Phone className="h-3 w-3" />
                        {player.contact_number}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1.5">
                      <Calendar className="h-3 w-3" />
                      Joined {formatRelative(player.registration_date)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {company?.company_name}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg border bg-muted/30 p-3">
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                    Lifetime Deposits
                  </div>
                  <div className="text-lg font-semibold mt-0.5">
                    {formatRM(player.total_deposits)}
                  </div>
                </div>
                <div className="rounded-lg border bg-muted/30 p-3">
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                    Lifetime Withdrawals
                  </div>
                  <div className="text-lg font-semibold mt-0.5">
                    {formatRM(player.total_withdrawals)}
                  </div>
                </div>
              </div>
            </SheetHeader>

            <div className="px-6 py-5 space-y-6">
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Current Game Balances
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {GAMES.map((g) => {
                    const row = playerCredits.find((c) => c.game_name === g);
                    const bal = row?.current_balance ?? 0;
                    return (
                      <div
                        key={g}
                        className="rounded-md border bg-card px-3 py-2 flex items-center justify-between"
                      >
                        <span className="text-sm font-medium">{g}</span>
                        <span className={bal > 0 ? "text-sm font-semibold" : "text-sm text-muted-foreground"}>
                          {formatRM(bal)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>

              <Separator />

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Bank Account on File
                </h3>
                {player.bank_account_number ? (
                  <div className="rounded-md border bg-card p-3 flex items-start gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Landmark className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">
                        {player.bank_account_holder ?? player.full_name}
                      </div>
                      <div className="text-[12px] font-mono text-muted-foreground mt-0.5">
                        {player.bank_account_number}
                      </div>
                    </div>
                    {player.bank_name && (
                      <span className="inline-flex items-center rounded-md border bg-muted/40 px-2 py-0.5 text-[11px]">
                        {player.bank_name}
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No bank account on file. Auto-matching incoming deposits is disabled for this player.
                  </p>
                )}
              </section>

              <Separator />

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Recent Deposits
                </h3>
                {playerDeposits.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No deposits yet.</p>
                ) : (
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-xs table-fixed">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-medium w-[34%]">Date</th>
                          <th className="px-2 py-1.5 text-right font-medium w-[22%]">Amount</th>
                          <th className="px-2 py-1.5 text-left font-medium w-[20%]">Game</th>
                          <th className="px-2 py-1.5 text-right font-medium w-[24%]">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {playerDeposits.map((d) => (
                          <tr key={d.deposit_id} className="border-t">
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {formatShortDateTime(d.deposit_date)}
                            </td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                              {formatRM(d.total_amount)}
                            </td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{d.selected_game ?? "—"}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                              <StatusBadge status={d.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Recent Withdrawals
                </h3>
                {playerWithdrawals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No withdrawals yet.</p>
                ) : (
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-xs table-fixed">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-medium w-[30%]">Date</th>
                          <th className="px-2 py-1.5 text-right font-medium w-[20%]">Amount</th>
                          <th className="px-2 py-1.5 text-left font-medium w-[20%]">Game</th>
                          <th className="px-2 py-1.5 text-right font-medium w-[30%]">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {playerWithdrawals.map((w) => (
                          <tr key={w.withdrawal_id} className="border-t">
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {formatShortDateTime(w.created_at)}
                            </td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                              {formatRM(w.requested_amount)}
                            </td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{w.game_name}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                              <StatusBadge status={w.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {player.notes && (
                <>
                  <Separator />
                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Internal Notes
                    </h3>
                    <div className="rounded-md border bg-muted/20 p-3 text-sm">
                      {player.notes}
                    </div>
                  </section>
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

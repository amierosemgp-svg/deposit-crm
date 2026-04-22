"use client";

import { useState, useMemo } from "react";
import { useStore } from "@/lib/store";
import { formatRM, formatDateTime, formatRelative } from "@/lib/format";
import { BONUS_OPTIONS, GAMES, BANKS } from "@/lib/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { PlayerNameLink } from "@/components/player-name-link";
import { ApprovalFlowModal } from "@/components/approval-flow-modal";
import { motion, AnimatePresence } from "framer-motion";
import {
  RefreshCw,
  Download,
  Filter,
  Zap,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export default function DepositsPage() {
  const deposits = useStore((s) => s.deposits);
  const updateDraft = useStore((s) => s.updateDepositDraft);

  const [bankFilter, setBankFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [approvingId, setApprovingId] = useState<number | null>(null);

  const filtered = useMemo(() => {
    return [...deposits]
      .filter((d) => bankFilter === "all" || d.bank_name === bankFilter)
      .filter((d) => statusFilter === "all" || d.status === statusFilter)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [deposits, bankFilter, statusFilter]);

  const pendingCount = deposits.filter((d) => d.status === "pending").length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Deposits</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Bot-detected bank transactions — approve &amp; auto top-up to games
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pendingCount > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
              {pendingCount} pending approval
            </div>
          )}
        </div>
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <Select value={bankFilter} onValueChange={(v) => setBankFilter(v ?? "all")}>
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All banks</SelectItem>
              {BANKS.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              Auto-refresh: every 30s
            </span>
            <Button variant="outline" size="sm">
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            <Button variant="outline" size="sm">
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Date &amp; Time</th>
                <th className="px-3 py-2.5 text-left font-medium">Player</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Deposit</th>
                <th className="px-3 py-2.5 text-left font-medium">Bank</th>
                <th className="px-3 py-2.5 text-left font-medium">Bonus %</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Bonus</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Total</th>
                <th className="px-3 py-2.5 text-left font-medium">Game</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {filtered.map((d) => {
                  const editable = d.status === "pending";
                  return (
                    <motion.tr
                      key={d.deposit_id}
                      layout
                      initial={d.is_new ? { opacity: 0, y: -12, backgroundColor: "rgba(16,185,129,0.15)" } : false}
                      animate={{ opacity: 1, y: 0, backgroundColor: "rgba(0,0,0,0)" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.45 }}
                      className={cn(
                        "border-t align-middle",
                        editable ? "bg-amber-50/50 hover:bg-amber-50" : "hover:bg-muted/30",
                      )}
                    >
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="text-[12px]">{formatDateTime(d.deposit_date)}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {formatRelative(d.deposit_date)} · {d.transaction_ref}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <PlayerNameLink playerId={d.player_id}>
                          {d.player_username}
                        </PlayerNameLink>
                        <div className="text-[10px] text-muted-foreground">P-{d.player_id}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                        {formatRM(d.deposit_amount)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center rounded-md border bg-card px-1.5 py-0.5 text-[11px]">
                          {d.bank_name}
                        </span>
                        <div className="mt-1 text-[12px] leading-tight">
                          {d.bank_account_holder}
                        </div>
                        <div className="text-[10px] font-mono text-muted-foreground">
                          {d.bank_account_number}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {editable ? (
                          <Select
                            value={String(d.bonus_percentage)}
                            onValueChange={(v) =>
                              updateDraft(d.deposit_id, {
                                bonus_percentage: Number(v),
                              })
                            }
                          >
                            <SelectTrigger className="h-7 w-[90px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {BONUS_OPTIONS.map((p) => (
                                <SelectItem key={p} value={String(p)}>
                                  {p}%
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-[12px]">{d.bonus_percentage}%</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap text-muted-foreground">
                        {formatRM(d.bonus_amount)}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                        {formatRM(d.total_amount)}
                      </td>
                      <td className="px-3 py-2">
                        {editable ? (
                          <Select
                            value={d.selected_game ?? ""}
                            onValueChange={(v) =>
                              updateDraft(d.deposit_id, {
                                selected_game: v as (typeof GAMES)[number],
                              })
                            }
                          >
                            <SelectTrigger className="h-7 w-[120px]">
                              <SelectValue placeholder="Pick game" />
                            </SelectTrigger>
                            <SelectContent>
                              {GAMES.map((g) => (
                                <SelectItem key={g} value={g}>
                                  {g}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-[12px]">{d.selected_game ?? "—"}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={d.status} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {editable ? (
                          <Button
                            size="sm"
                            onClick={() => setApprovingId(d.deposit_id)}
                            disabled={!d.selected_game}
                            className="bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/30 disabled:text-white/70"
                          >
                            <Zap className="h-3.5 w-3.5" />
                            Approve &amp; Top-Up
                          </Button>
                        ) : d.status === "completed" ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Credited
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        )}
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
          <span>
            Showing {filtered.length} of {deposits.length} deposits
          </span>
          <span>Connected: OpenClaw Bot · Last sync 2s ago</span>
        </div>
      </Card>

      <ApprovalFlowModal
        depositId={approvingId}
        open={approvingId !== null}
        onOpenChange={(o) => !o && setApprovingId(null)}
      />
    </div>
  );
}

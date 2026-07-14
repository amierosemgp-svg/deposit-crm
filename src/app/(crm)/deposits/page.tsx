"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { formatRM, formatDateTime, formatRelative } from "@/lib/format";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/status-badge";
import { PlayerNameLink } from "@/components/player-name-link";
import { ApprovalFlowModal } from "@/components/approval-flow-modal";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  RefreshCw,
  Download,
  Filter,
  Zap,
  CheckCircle2,
  Plus,
  Paperclip,
  Inbox,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Deposit } from "@/lib/types";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "pending_match", label: "Awaiting Bank Match" },
  { value: "matched", label: "Bank Matched" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

export default function DepositsPage() {
  const deposits = useStore((s) => s.deposits);
  const players = useStore((s) => s.players);
  const me = useStore((s) => s.me);
  const hydrated = useStore((s) => s.hydrated);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const updateDraft = useStore((s) => s.updateDepositDraft);
  const refresh = useStore((s) => s.refresh);
  const companiesFn = useStore((s) => s.companies);
  const banksFn = useStore((s) => s.banks);
  const gamesFn = useStore((s) => s.games);
  const bonusOptionsFn = useStore((s) => s.bonusOptions);

  const banks = banksFn();
  const games = gamesFn();
  const bonusOptions = bonusOptionsFn();
  const isViewer = me?.role === "viewer";

  const [bankFilter, setBankFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [newDepositOpen, setNewDepositOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const scopedDeposits = useMemo(
    () =>
      deposits.filter(
        (d) =>
          selectedCompanyId === null ||
          // Unmatched bot deposits have no company yet — keep them visible so they can be assigned.
          d.company_entity_id === null ||
          d.company_entity_id === selectedCompanyId,
      ),
    [deposits, selectedCompanyId],
  );

  const filtered = useMemo(() => {
    return [...scopedDeposits]
      .filter((d) => bankFilter === "all" || d.bank_name === bankFilter)
      .filter((d) => statusFilter === "all" || d.status === statusFilter)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [scopedDeposits, bankFilter, statusFilter]);

  const pendingCount = scopedDeposits.filter(
    (d) => d.status === "pending" || d.status === "matched",
  ).length;
  const activeCompany = companiesFn().find(
    (c) => c.company_id === selectedCompanyId,
  );

  async function handleDraft(
    depositId: number,
    patch: Partial<Pick<Deposit, "bonus_percentage" | "selected_game" | "player_id">>,
  ) {
    const res = await updateDraft(depositId, patch);
    if (!res.ok) toast.error(res.error ?? "Failed to update deposit");
  }

  async function handleRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  function exportCsv() {
    const header = [
      "Deposit ID",
      "Date",
      "Transaction Ref",
      "Player",
      "Bank Description",
      "Deposit Amount",
      "Bank",
      "Account Holder",
      "Account Number",
      "Bonus %",
      "Bonus Amount",
      "Total",
      "Game",
      "Status",
      "Receipt URL",
    ];
    const rows = filtered.map((d) => [
      d.deposit_id,
      d.deposit_date,
      d.transaction_ref,
      d.player_username ?? "",
      d.bank_description ?? "",
      d.deposit_amount.toFixed(2),
      d.bank_name,
      d.bank_account_holder ?? "",
      d.bank_account_number ?? "",
      d.bonus_percentage,
      d.bonus_amount.toFixed(2),
      d.total_amount.toFixed(2),
      d.selected_game ?? "",
      d.status,
      d.receipt_url ?? "",
    ]);
    const csv = [header, ...rows]
      .map((r) =>
        r.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `deposits-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Deposits</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Bot-detected bank transactions — approve &amp; auto top-up to games
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
          {!isViewer && (
            <Button
              onClick={() => setNewDepositOpen(true)}
              className="cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              New Deposit
            </Button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <Select value={bankFilter} onValueChange={(v) => setBankFilter(v ?? "all")}>
            <SelectTrigger className="h-8 w-[130px] cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All banks</SelectItem>
              {banks.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
            <SelectTrigger className="h-8 w-[170px] cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              Auto-refresh: every 10s
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
              className="cursor-pointer"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={exportCsv}
              disabled={filtered.length === 0}
              className="cursor-pointer"
            >
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
                  const actionable = d.status === "pending" || d.status === "matched";
                  const editable = actionable && !isViewer;
                  const canApprove =
                    editable && d.player_id !== null && !!d.selected_game;
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
                        {d.player_id !== null ? (
                          <>
                            <PlayerNameLink playerId={d.player_id}>
                              {d.player_username ?? `P-${d.player_id}`}
                            </PlayerNameLink>
                            <div className="text-[10px] text-muted-foreground">P-{d.player_id}</div>
                          </>
                        ) : (
                          <div className="space-y-1.5">
                            {d.bank_description ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span className="block max-w-[170px] cursor-default truncate text-[12px] italic text-muted-foreground" />
                                  }
                                >
                                  {d.bank_description}
                                </TooltipTrigger>
                                <TooltipContent>{d.bank_description}</TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="block text-[12px] italic text-muted-foreground">
                                Unmatched deposit
                              </span>
                            )}
                            {editable && (
                              <Select
                                onValueChange={(v) => {
                                  if (v) void handleDraft(d.deposit_id, { player_id: Number(v) });
                                }}
                              >
                                <SelectTrigger className="h-7 w-[150px] cursor-pointer">
                                  <SelectValue placeholder="Assign player" />
                                </SelectTrigger>
                                <SelectContent>
                                  {players.length === 0 ? (
                                    <SelectItem value="none" disabled>
                                      No players yet
                                    </SelectItem>
                                  ) : (
                                    players.map((p) => (
                                      <SelectItem
                                        key={p.player_id}
                                        value={String(p.player_id)}
                                      >
                                        {p.full_name} (@{p.username})
                                      </SelectItem>
                                    ))
                                  )}
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                        {formatRM(d.deposit_amount)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 text-[11px]">
                          {d.bank_name}
                          {d.receipt_url && (
                            <a
                              href={d.receipt_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="cursor-pointer text-muted-foreground hover:text-primary"
                              title="View receipt"
                            >
                              <Paperclip className="h-3 w-3" />
                            </a>
                          )}
                        </span>
                        {d.bank_account_holder && (
                          <div className="mt-1 text-[12px] leading-tight">
                            {d.bank_account_holder}
                          </div>
                        )}
                        {d.bank_account_number && (
                          <div className="text-[10px] font-mono text-muted-foreground">
                            {d.bank_account_number}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {editable ? (
                          <Select
                            value={String(d.bonus_percentage)}
                            onValueChange={(v) => {
                              if (v !== null)
                                void handleDraft(d.deposit_id, { bonus_percentage: Number(v) });
                            }}
                          >
                            <SelectTrigger className="h-7 w-[90px] cursor-pointer">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {bonusOptions.map((p) => (
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
                            value={d.selected_game ?? null}
                            onValueChange={(v) => {
                              if (v) void handleDraft(d.deposit_id, { selected_game: v });
                            }}
                          >
                            <SelectTrigger className="h-7 w-[120px] cursor-pointer">
                              <SelectValue placeholder="Pick game" />
                            </SelectTrigger>
                            <SelectContent>
                              {games.map((g) => (
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
                        {actionable && !isViewer ? (
                          <Button
                            size="sm"
                            onClick={() => setApprovingId(d.deposit_id)}
                            disabled={!canApprove}
                            className="cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/30 disabled:text-white/70"
                          >
                            <Zap className="h-3.5 w-3.5" />
                            Approve &amp; Top-Up
                          </Button>
                        ) : d.status === "completed" ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Credited
                          </span>
                        ) : d.status === "pending_match" ? (
                          <span className="text-[11px] text-muted-foreground">
                            Waiting for bot
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

          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 border-t py-16 text-center">
              {!hydrated ? (
                <>
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Loading deposits…</p>
                </>
              ) : deposits.length === 0 ? (
                <>
                  <Inbox className="h-8 w-8 text-muted-foreground/60" />
                  <p className="text-sm font-medium">No deposits yet</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Bank transactions detected by the bot will appear here
                    automatically{isViewer ? "." : ", or create one manually with “New Deposit”."}
                  </p>
                </>
              ) : (
                <>
                  <Filter className="h-6 w-6 text-muted-foreground/60" />
                  <p className="text-sm text-muted-foreground">
                    No deposits match the current filters.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
          <span>
            Showing {filtered.length} of {scopedDeposits.length} deposits
            {selectedCompanyId !== null && (
              <span className="text-muted-foreground/70">
                {" "}
                ({deposits.length} total across all companies)
              </span>
            )}
          </span>
          <span>Connected: OpenClaw Bot · Auto-sync every 10s</span>
        </div>
      </Card>

      <ApprovalFlowModal
        depositId={approvingId}
        open={approvingId !== null}
        onOpenChange={(o) => !o && setApprovingId(null)}
      />

      <NewDepositDialog open={newDepositOpen} onOpenChange={setNewDepositOpen} />
    </div>
  );
}

function NewDepositDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const players = useStore((s) => s.players);
  const banksFn = useStore((s) => s.banks);
  const createDepositIntent = useStore((s) => s.createDepositIntent);
  const uploadFile = useStore((s) => s.uploadFile);
  const banks = banksFn();

  const [playerId, setPlayerId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [bank, setBank] = useState<string>("");
  const [verified, setVerified] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setPlayerId("");
        setAmount("");
        setBank("");
        setVerified(false);
        setFile(null);
        setSubmitting(false);
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  const amt = Number.parseFloat(amount);
  const isValid = playerId !== "" && Number.isFinite(amt) && amt > 0 && bank !== "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);

    let receipt_url: string | undefined;
    if (file) {
      const up = await uploadFile(file);
      if (!up.ok) {
        toast.error(up.error ?? "Receipt upload failed");
        setSubmitting(false);
        return;
      }
      receipt_url = up.url;
    }

    const res = await createDepositIntent({
      player_id: Number(playerId),
      amount: amt,
      bank_name: bank,
      status: verified ? "pending" : "pending_match",
      receipt_url,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error ?? "Failed to create deposit");
      return;
    }
    toast.success(
      verified
        ? "Deposit created — ready for approval"
        : "Deposit intent created — awaiting bank match",
    );
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">New deposit</DialogTitle>

        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Plus className="h-4.5 w-4.5" />
          </div>
          <div>
            <h2 className="text-base font-semibold leading-tight">New deposit</h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              Record a deposit reported by a player
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <div className="space-y-1.5">
            <Label>
              Player <span className="text-rose-600">*</span>
            </Label>
            <Select value={playerId || null} onValueChange={(v) => setPlayerId(v ?? "")}>
              <SelectTrigger className="h-8 w-full cursor-pointer">
                <SelectValue placeholder="Select player" />
              </SelectTrigger>
              <SelectContent>
                {players.length === 0 ? (
                  <SelectItem value="none" disabled>
                    No players yet — create one first
                  </SelectItem>
                ) : (
                  players.map((p) => (
                    <SelectItem key={p.player_id} value={String(p.player_id)}>
                      {p.full_name} (@{p.username})
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="nd-amount">
                Amount (RM) <span className="text-rose-600">*</span>
              </Label>
              <Input
                id="nd-amount"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="100.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                Bank <span className="text-rose-600">*</span>
              </Label>
              <Select value={bank || null} onValueChange={(v) => setBank(v ?? "")}>
                <SelectTrigger className="h-8 w-full cursor-pointer">
                  <SelectValue placeholder="Select bank" />
                </SelectTrigger>
                <SelectContent>
                  {banks.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-muted/20 p-3 select-none">
            <input
              type="checkbox"
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
              className="mt-0.5 h-4 w-4 cursor-pointer accent-primary"
            />
            <span>
              <span className="block text-sm font-medium">
                Receipt already verified
              </span>
              <span className="block text-[11px] text-muted-foreground mt-0.5">
                {verified
                  ? "Created as Pending — ready to approve immediately."
                  : "Created as Awaiting Bank Match — the bot will confirm the bank transaction."}
              </span>
            </span>
          </label>

          <div className="space-y-1.5">
            <Label htmlFor="nd-receipt">Receipt (optional)</Label>
            <input
              id="nd-receipt"
              type="file"
              accept="image/*,.pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full cursor-pointer text-xs text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-background file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted"
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isValid || submitting}
              className="cursor-pointer"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Create deposit
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

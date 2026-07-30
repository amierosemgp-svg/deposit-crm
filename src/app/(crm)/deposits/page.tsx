"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { formatRM, formatDateTime } from "@/lib/format";
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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBadge, SourceBadge } from "@/components/status-badge";
import { SearchableSelect } from "@/components/searchable-select";
import { AssigneeCell } from "@/components/assignee-cell";
import { PlayerNameLink } from "@/components/player-name-link";
import { ApprovalFlowModal } from "@/components/approval-flow-modal";
import { AssignPlayerSheet } from "@/components/assign-player-sheet";
import { ManualDepositDialog } from "@/components/manual-deposit-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  RefreshCw,
  Download,
  Filter,
  Plus,
  Search,
  Zap,
  CheckCircle2,
  Paperclip,
  Inbox,
  Loader2,
  RotateCcw,
  UserPlus,
  UserCheck,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Deposit } from "@/lib/types";

const STATUS_FILTERS: { value: string; tab: string }[] = [
  { value: "pending", tab: "Pending" },
  { value: "pending_match", tab: "Awaiting Match" },
  { value: "matched", tab: "Matched" },
  { value: "approved", tab: "Approved" },
  { value: "processing", tab: "Processing" },
  { value: "completed", tab: "Completed" },
  { value: "failed", tab: "Failed" },
  { value: "all", tab: "All" },
];

/** Reject control for manual (skip-bot) deposits — confirms, then fails the row. */
function RejectDepositButton({
  depositId,
  onReject,
}: {
  depositId: number;
  onReject: (id: number) => Promise<{ ok: boolean; error?: string }>;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        if (!confirm("Reject this deposit? It will be marked failed.")) return;
        const r = await onReject(depositId);
        if (!r.ok) toast.error(r.error ?? "Reject failed");
        else toast.success("Deposit rejected");
      }}
      className="cursor-pointer gap-1 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
    >
      <X className="h-3.5 w-3.5" />
      Reject
    </Button>
  );
}

export default function DepositsPage() {
  const deposits = useStore((s) => s.deposits);
  const me = useStore((s) => s.me);
  const hydrated = useStore((s) => s.hydrated);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const companyInScope = useStore((s) => s.companyInScope);
  const updateDraft = useStore((s) => s.updateDepositDraft);
  const approveDeposit = useStore((s) => s.approveDeposit);
  const completeDeposit = useStore((s) => s.completeDeposit);
  const rejectDeposit = useStore((s) => s.rejectDeposit);
  const reprocessDeposit = useStore((s) => s.reprocessDeposit);
  const refresh = useStore((s) => s.refresh);
  const companiesFn = useStore((s) => s.companies);
  const banksFn = useStore((s) => s.banks);
  const playerById = useStore((s) => s.playerById);
  const setAssignment = useStore((s) => s.setAssignment);
  const bonusOptionsFn = useStore((s) => s.bonusOptions);

  const banks = banksFn();
  const bonusOptions = bonusOptionsFn();
  const isViewer = me?.role === "viewer";

  const [bankFilter, setBankFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [assignTargets, setAssignTargets] = useState<number[] | null>(null);
  const [bulkApproving, setBulkApproving] = useState(false);
  const [bulkSettingGame, setBulkSettingGame] = useState(false);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [manualDepositOpen, setManualDepositOpen] = useState(false);

  const scopedDeposits = useMemo(
    () =>
      deposits.filter(
        (d) =>
          // Unmatched bot deposits have no company yet — keep them visible so they can be assigned.
          d.company_entity_id === null || companyInScope(d.company_entity_id),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deposits, selectedCompanyId, selectedLeaderId],
  );

  // Bank + search applied first; the status tabs show counts from this set.
  const searched = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return scopedDeposits
      .filter((d) => bankFilter === "all" || d.bank_name === bankFilter)
      .filter((d) => {
        if (!q) return true;
        return [
          d.transaction_ref,
          d.player_username,
          d.bank_description,
          d.bank_account_holder,
          d.bank_account_number,
          d.bank_name,
          d.selected_game,
          String(d.deposit_amount),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
  }, [scopedDeposits, bankFilter, searchQuery]);

  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of searched) m.set(d.status, (m.get(d.status) ?? 0) + 1);
    return m;
  }, [searched]);

  const filtered = useMemo(
    () =>
      [...searched]
        .filter((d) => statusFilter === "all" || d.status === statusFilter)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [searched, statusFilter],
  );

  // Rows that can be selected for bulk actions: pending/matched and writable.
  const selectableIds = useMemo(
    () =>
      isViewer
        ? []
        : filtered
            .filter((d) => d.status === "pending" || d.status === "matched")
            .map((d) => d.deposit_id),
    [filtered, isViewer],
  );
  // Effective selection — drop rows that left the filter or became non-actionable.
  const selected = useMemo(
    () => selectableIds.filter((id) => selectedIds.has(id)),
    [selectableIds, selectedIds],
  );
  const approvable = useMemo(
    () =>
      filtered
        .filter(
          (d) =>
            selected.includes(d.deposit_id) &&
            d.player_id !== null &&
            !!d.selected_game,
        )
        .map((d) => d.deposit_id),
    [filtered, selected],
  );

  function toggleRow(depositId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(depositId)) next.delete(depositId);
      else next.add(depositId);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((prev) =>
      selected.length === selectableIds.length && selectableIds.length > 0
        ? new Set()
        : new Set([...prev, ...selectableIds]),
    );
  }

  /**
   * Games offered for a batch: every game linked to at least one selected
   * deposit's player. A game only some of them have is still worth offering —
   * the ones that can't take it are reported rather than silently skipped.
   */
  const batchGameOptions = useMemo(() => {
    const games = new Set<string>();
    for (const d of filtered) {
      if (!selected.includes(d.deposit_id) || d.player_id == null) continue;
      for (const g of playerById(d.player_id)?.game_accounts ?? []) {
        games.add(g.game_name);
      }
    }
    return [...games].sort((a, b) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, selected]);

  /** Apply one game provider to every selected deposit whose player has it. */
  async function handleBulkGame(game: string) {
    if (bulkApproving || bulkSettingGame) return;
    const targets = filtered.filter(
      (d) =>
        selected.includes(d.deposit_id) &&
        d.player_id != null &&
        (playerById(d.player_id)?.game_accounts ?? []).some(
          (g) => g.game_name === game,
        ),
    );
    const skipped = selected.length - targets.length;
    if (targets.length === 0) {
      toast.error(`No selected deposit has a ${game} account linked`);
      return;
    }
    setBulkSettingGame(true);
    let ok = 0;
    let failed = 0;
    for (const d of targets) {
      const res = await updateDraft(d.deposit_id, { selected_game: game });
      if (res.ok) ok += 1;
      else failed += 1;
    }
    setBulkSettingGame(false);
    if (ok > 0) toast.success(`${game} set on ${ok} deposit${ok === 1 ? "" : "s"}`);
    if (failed > 0) toast.error(`${failed} could not be updated`);
    if (skipped > 0)
      toast.warning(
        `${skipped} skipped — no ${game} account linked to that player`,
      );
  }

  /** Claim every selected deposit that isn't already someone else's. */
  async function handleBulkAssign() {
    if (selected.length === 0 || bulkAssigning) return;
    setBulkAssigning(true);
    const res = await setAssignment({ kind: "deposit", ids: selected });
    setBulkAssigning(false);
    if (!res.ok) {
      toast.error(res.error ?? "Could not assign");
      return;
    }
    toast.success(
      `${res.changed} deposit${res.changed === 1 ? "" : "s"} assigned to you`,
    );
    if (res.skipped) {
      toast.warning(
        `${res.skipped} skipped — already assigned to someone else`,
      );
    }
  }

  async function handleBulkApprove() {
    if (approvable.length === 0 || bulkApproving) return;
    setBulkApproving(true);
    let ok = 0;
    let failed = 0;
    for (const id of approvable) {
      const res = await approveDeposit(id);
      if (res.ok) ok += 1;
      else failed += 1;
    }
    setBulkApproving(false);
    setSelectedIds(new Set());
    if (ok > 0)
      toast.success(`${ok} deposit${ok === 1 ? "" : "s"} approved — bot topping up`);
    if (failed > 0)
      toast.error(`${failed} deposit${failed === 1 ? "" : "s"} failed to approve`);
  }

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
            Bot-detected bank transactions — approve, then the bot tops up the game
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
              onClick={() => setManualDepositOpen(true)}
              className="cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              Manual deposit
            </Button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <Select
            value={bankFilter}
            onValueChange={(v) => setBankFilter(v ?? "all")}
            items={[
              { value: "all", label: "All banks" },
              ...banks.map((b) => ({ value: b, label: b })),
            ]}
          >
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
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search ref, player, bank, game…"
              className="h-8 w-[230px] pl-8"
            />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {selected.length > 0 ? (
              <>
                <span className="mr-1 text-[11px] font-medium">
                  {selected.length} selected
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAssignTargets(selected)}
                  disabled={bulkApproving}
                  className="cursor-pointer"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Assign player
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleBulkAssign()}
                  disabled={bulkApproving || bulkAssigning}
                  title="Claim these deposits so other agents can see you're on them"
                  className="cursor-pointer"
                >
                  {bulkAssigning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <UserCheck className="h-3.5 w-3.5" />
                  )}
                  Assign to me
                </Button>
                <SearchableSelect
                  value={null}
                  onValueChange={(g) => void handleBulkGame(g)}
                  options={batchGameOptions}
                  placeholder={bulkSettingGame ? "Setting…" : "Set game"}
                  emptyMessage="No games linked to the selected players"
                  searchPlaceholder="Search game…"
                  disabled={bulkApproving || bulkSettingGame}
                  className="h-8 w-[130px] text-[12px]"
                />
                <Button
                  size="sm"
                  onClick={() => void handleBulkApprove()}
                  disabled={approvable.length === 0 || bulkApproving}
                  className="cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/30 disabled:text-white/70"
                >
                  {bulkApproving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                  Approve ({approvable.length})
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                  disabled={bulkApproving}
                  className="cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                  Clear
                </Button>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </div>

        {/* Status tabs */}
        <div className="flex flex-wrap gap-1 border-b px-4 py-2">
          {STATUS_FILTERS.map((s) => {
            const count =
              s.value === "all"
                ? searched.length
                : (statusCounts.get(s.value) ?? 0);
            const active = statusFilter === s.value;
            return (
              <button
                key={s.value}
                onClick={() => setStatusFilter(s.value)}
                className={cn(
                  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {s.tab}
                {count > 0 && (
                  <span
                    className={cn(
                      "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                      active
                        ? "bg-primary-foreground/20"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                {!isViewer && (
                  <th className="w-9 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all actionable deposits"
                      checked={
                        selectableIds.length > 0 &&
                        selected.length === selectableIds.length
                      }
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            selected.length > 0 &&
                            selected.length < selectableIds.length;
                      }}
                      onChange={toggleAll}
                      disabled={selectableIds.length === 0 || bulkApproving}
                      className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                    />
                  </th>
                )}
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Date &amp; Time</th>
                <th className="px-3 py-2.5 text-left font-medium">Player</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Deposit</th>
                <th className="px-3 py-2.5 text-left font-medium">Bank</th>
                <th className="px-3 py-2.5 text-left font-medium">Bonus %</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Bonus</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Total</th>
                <th className="px-3 py-2.5 text-left font-medium">Game</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">
                  Handled by
                </th>
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
                        selectedIds.has(d.deposit_id) && editable
                          ? "bg-primary/5 hover:bg-primary/10"
                          : editable
                            ? "bg-amber-50/50 hover:bg-amber-50"
                            : "hover:bg-muted/30",
                      )}
                    >
                      {!isViewer && (
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Select deposit ${d.transaction_ref}`}
                            checked={editable && selectedIds.has(d.deposit_id)}
                            onChange={() => toggleRow(d.deposit_id)}
                            disabled={!editable || bulkApproving}
                            className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-30"
                          />
                        </td>
                      )}
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="text-[12px]">{formatDateTime(d.deposit_date)}</div>
                        <div className="text-[10px] text-muted-foreground" title={d.transaction_ref}>
                          {d.transaction_ref.length > 10
                            ? `${d.transaction_ref.slice(0, 10)}…`
                            : d.transaction_ref}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {d.player_id !== null ? (
                          <>
                            <PlayerNameLink playerId={d.player_id}>
                              {d.player_username ?? `P-${d.player_id}`}
                            </PlayerNameLink>
                            {editable && (
                              <button
                                type="button"
                                onClick={() => setAssignTargets([d.deposit_id])}
                                className="block cursor-pointer text-[11px] text-muted-foreground underline underline-offset-2 hover:text-primary"
                              >
                                Change
                              </button>
                            )}
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
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setAssignTargets([d.deposit_id])}
                                className="h-7 cursor-pointer gap-1 text-[12px]"
                              >
                                <UserPlus className="h-3 w-3" />
                                Assign player
                              </Button>
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
                            <button
                              type="button"
                              onClick={() => setReceiptUrl(d.receipt_url!)}
                              className="cursor-pointer text-muted-foreground hover:text-primary"
                              title="View receipt"
                            >
                              <Paperclip className="h-3 w-3" />
                            </button>
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
                            items={bonusOptions.map((p) => ({
                              value: String(p),
                              label: `${p}%`,
                            }))}
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
                          (() => {
                            const rowPlayer =
                              d.player_id != null ? playerById(d.player_id) : undefined;
                            // Games the selected player has linked accounts for.
                            const rowGames = (rowPlayer?.game_accounts ?? []).map(
                              (g) => g.game_name,
                            );
                            // Keep an already-picked game visible even if it's since dropped off the list.
                            const options =
                              d.selected_game && !rowGames.includes(d.selected_game)
                                ? [...rowGames, d.selected_game]
                                : rowGames;
                            const emptyMsg = !rowPlayer
                              ? "Assign a player first"
                              : "No games linked to this player";
                            return (
                              <SearchableSelect
                                value={d.selected_game ?? null}
                                onValueChange={(v) => {
                                  if (v) void handleDraft(d.deposit_id, { selected_game: v });
                                }}
                                options={[...options].sort((a, b) =>
                                  a.localeCompare(b),
                                )}
                                placeholder="Pick game"
                                emptyMessage={emptyMsg}
                                searchPlaceholder="Search game…"
                                className="h-7 w-[130px] px-2 text-[12px]"
                              />
                            );
                          })()
                        ) : (
                          <span className="text-[12px]">{d.selected_game ?? "—"}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge status={d.status} />
                          <div className="flex items-center gap-1">
                            <SourceBadge source={d.source} />
                            {d.skip_bot && (
                              <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                                No bot
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <AssigneeCell
                          kind="deposit"
                          id={d.deposit_id}
                          assignedToUserId={d.assigned_to_user_id}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {!isViewer &&
                        d.skip_bot &&
                        (d.status === "pending" || d.status === "matched") ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="sm"
                              onClick={async () => {
                                const r = await approveDeposit(d.deposit_id);
                                if (!r.ok) toast.error(r.error ?? "Approve failed");
                              }}
                              disabled={!canApprove}
                              className="cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/30 disabled:text-white/70"
                            >
                              <Zap className="h-3.5 w-3.5" />
                              Approve
                            </Button>
                            <RejectDepositButton depositId={d.deposit_id} onReject={rejectDeposit} />
                          </div>
                        ) : !isViewer && d.skip_bot && d.status === "processing" ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="sm"
                              onClick={async () => {
                                const r = await completeDeposit(d.deposit_id);
                                if (!r.ok) toast.error(r.error ?? "Complete failed");
                                else toast.success("Deposit completed — credit booked");
                              }}
                              className="cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Complete
                            </Button>
                            <RejectDepositButton depositId={d.deposit_id} onReject={rejectDeposit} />
                          </div>
                        ) : actionable && !isViewer ? (
                          <Button
                            size="sm"
                            onClick={() => setApprovingId(d.deposit_id)}
                            disabled={!canApprove}
                            className="cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/30 disabled:text-white/70"
                          >
                            <Zap className="h-3.5 w-3.5" />
                            Approve
                          </Button>
                        ) : d.status === "completed" ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Credited
                          </span>
                        ) : d.status === "processing" || d.status === "approved" ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-blue-700">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Bot topping up…
                          </span>
                        ) : d.status === "pending_match" ? (
                          <span className="text-[11px] text-muted-foreground">
                            Waiting for bot
                          </span>
                        ) : d.status === "failed" ? (
                          isViewer ? (
                            <span className="text-[11px] text-red-600">Top-up failed</span>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="cursor-pointer gap-1 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
                              onClick={async () => {
                                const r = await reprocessDeposit(d.deposit_id);
                                if (!r.ok) toast.error(r.error ?? "Reprocess failed");
                                else toast.success("Deposit reopened — review and approve to retry");
                              }}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Reprocess
                            </Button>
                          )
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
                    automatically.
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

      <AssignPlayerSheet
        depositIds={assignTargets ?? []}
        open={assignTargets !== null}
        onOpenChange={(o) => !o && setAssignTargets(null)}
      />

      <ReceiptModal url={receiptUrl} onClose={() => setReceiptUrl(null)} />

      <ManualDepositDialog
        open={manualDepositOpen}
        onOpenChange={setManualDepositOpen}
      />
    </div>
  );
}

function ReceiptModal({ url, onClose }: { url: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!url} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Deposit receipt</DialogTitle>
        {url && (
          <div className="mt-2 space-y-3">
            <div className="max-h-[70vh] overflow-auto rounded-md border bg-muted/30 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt="Deposit receipt"
                className="mx-auto max-w-full rounded"
              />
            </div>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            >
              <Paperclip className="h-3 w-3" /> Open original in new tab
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

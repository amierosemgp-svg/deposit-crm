"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { formatRM, formatRelative, formatShortDateTime } from "@/lib/format";
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
import { StatusBadge, SourceBadge } from "@/components/status-badge";
import { SearchableSelect } from "@/components/searchable-select";
import { BonusPicker } from "@/components/bonus-picker";
import { AssigneeCell } from "@/components/assignee-cell";
import { PlayerNameLink } from "@/components/player-name-link";
import { ApprovalFlowModal } from "@/components/approval-flow-modal";
import { AssignPlayerSheet } from "@/components/assign-player-sheet";
import { ManualDepositDialog } from "@/components/manual-deposit-dialog";
import {
  ConfirmActionDialog,
  type SummaryRow,
} from "@/components/confirm-action-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  RefreshCw,
  Download,
  Filter,
  Plus,
  Radar,
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
import type { BotCommand, Deposit } from "@/lib/types";
import { OPEN_BOT_COMMAND_STATUSES } from "@/lib/types";
import { extractSenderName } from "@/lib/bank-remark";

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

/** Reject control for manual (skip-agent) deposits — opens the confirm dialog. */
function RejectDepositButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={onClick}
      className="cursor-pointer gap-1 border-red-300 text-red-700 dark:text-red-300 hover:bg-red-50 hover:text-red-800"
    >
      <X className="h-3 w-3" />
      Reject
    </Button>
  );
}

/**
 * The Crawl banks tooltip — what the last crawl did, in one line.
 *
 * The button itself can only say "Crawling…"; this is where "and the last one
 * found nothing" lives, so an empty crawl and a productive one are told apart
 * without opening the system log. Counters come from whatever the agent put in
 * `result`, which is free-form: read the two we name and ignore the rest.
 */
function crawlHint(cmd: BotCommand | null): string {
  if (!cmd) {
    return "Re-read the banks now instead of waiting for the agent's next sweep";
  }
  const when = formatRelative(cmd.completed_at ?? cmd.created_at);
  switch (cmd.status) {
    case "pending":
      return `Queued ${when} — waiting for an agent to pick it up`;
    case "running":
      return `Crawling since ${when}${cmd.bot_id ? ` · ${cmd.bot_id}` : ""}`;
    case "completed": {
      const found = Number(cmd.result?.deposits_created ?? NaN);
      const seen = Number(cmd.result?.transactions_found ?? NaN);
      const detail = Number.isFinite(found)
        ? found === 1
          ? "1 new deposit"
          : `${found} new deposits`
        : Number.isFinite(seen)
          ? `${seen} transactions read`
          : "nothing reported";
      return `Last crawl finished ${when} — ${detail}`;
    }
    case "failed":
      return `Last crawl failed ${when}${cmd.error ? ` — ${cmd.error}` : ""}`;
    case "expired":
      return `Last crawl expired ${when} — no agent picked it up`;
  }
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
  const bonusPlanById = useStore((s) => s.bonusPlanById);
  const botCommands = useStore((s) => s.botCommands);
  const requestBankCrawl = useStore((s) => s.requestBankCrawl);

  const banks = banksFn();
  const isViewer = me?.role === "viewer";

  const [bankFilter, setBankFilter] = useState<string>("all");
  // Agent-detected vs hand-entered. Deposits taken before the column existed
  // have no source at all, so an absent one counts as agent-detected — that is
  // what it was.
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [approvingId, setApprovingId] = useState<number | null>(null);
  // Deposit awaiting a confirmed approve (skip-agent rows) / reject / bulk approve.
  const [confirmApproveId, setConfirmApproveId] = useState<number | null>(null);
  const [confirmRejectId, setConfirmRejectId] = useState<number | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [assignTargets, setAssignTargets] = useState<number[] | null>(null);
  const [bulkApproving, setBulkApproving] = useState(false);
  const [bulkSettingGame, setBulkSettingGame] = useState(false);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [manualDepositOpen, setManualDepositOpen] = useState(false);
  const [crawlRequesting, setCrawlRequesting] = useState(false);

  const scopedDeposits = useMemo(
    () =>
      deposits.filter(
        (d) =>
          // Unmatched agent deposits have no company yet — keep them visible so they can be assigned.
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
      .filter(
        (d) => sourceFilter === "all" || (d.source ?? "bot") === sourceFilter,
      )
      .filter((d) => {
        if (!q) return true;
        return [
          d.transaction_ref,
          d.player_username,
          d.bank_description,
          extractSenderName(d.bank_description),
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
  }, [scopedDeposits, bankFilter, sourceFilter, searchQuery]);

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
  // Approving dispatches to the agent under your name, so it needs the claim —
  // the server rejects an approve on a deposit you don't hold.
  const approvable = useMemo(
    () =>
      filtered
        .filter(
          (d) =>
            selected.includes(d.deposit_id) &&
            d.player_id !== null &&
            !!d.selected_game &&
            d.assigned_to_user_id === me?.user_id,
        )
        .map((d) => d.deposit_id),
    [filtered, selected, me?.user_id],
  );

  const depositById = (id: number | null) =>
    id === null ? undefined : deposits.find((d) => d.deposit_id === id);

  /** What the confirm dialog restates back before the action is taken. */
  function depositSummary(d: Deposit): SummaryRow[] {
    const player = d.player_id != null ? playerById(d.player_id) : undefined;
    const sender = extractSenderName(d.bank_description);
    return [
      { label: "Player", value: player?.full_name ?? d.player_username ?? "—" },
      { label: "Member code", value: player?.username ?? "—" },
      { label: "Reference", value: d.transaction_ref },
      { label: "Bank", value: `${d.bank_name}${d.bank_account_number ? ` · ${d.bank_account_number}` : ""}` },
      ...(sender ? [{ label: "Sender", value: sender }] : []),
      { label: "Game", value: d.selected_game ?? "—" },
      {
        label: "Deposit + bonus",
        value: `${formatRM(d.deposit_amount)} + ${formatRM(d.bonus_amount)}`,
      },
      { label: "Total to credit", value: formatRM(d.total_amount), emphasis: true },
    ];
  }

  async function runApprove(depositId: number) {
    const d = depositById(depositId);
    setConfirmApproveId(null);
    if (!d?.skip_bot) {
      // ApprovalFlowModal performs the approve itself and animates the handoff.
      setApprovingId(depositId);
      return;
    }
    const r = await approveDeposit(depositId);
    if (!r.ok) toast.error(r.error ?? "Approve failed");
    else toast.success("Deposit approved — agent topping up");
  }

  async function runReject(depositId: number) {
    const r = await rejectDeposit(depositId);
    if (!r.ok) toast.error(r.error ?? "Reject failed");
    else toast.success("Deposit rejected");
    setConfirmRejectId(null);
  }

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
    setConfirmBulk(false);
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
      toast.success(`${ok} deposit${ok === 1 ? "" : "s"} approved — agent topping up`);
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
    patch: Partial<
      Pick<
        Deposit,
        "bonus_percentage" | "bonus_plan_id" | "selected_game" | "player_id"
      >
    > & { bonus_override_reason?: string },
  ) {
    const res = await updateDraft(depositId, patch);
    if (!res.ok) toast.error(res.error ?? "Failed to update deposit");
  }

  // The crawl that matters to what's on screen: the newest one covering the
  // selected company. Unscoped commands crawl every bank, this one included.
  const latestCrawl = useMemo(
    () =>
      botCommands.find(
        (c) =>
          c.command === "crawl_bank" &&
          (c.company_entity_id === null || companyInScope(c.company_entity_id)),
      ) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [botCommands, selectedCompanyId, selectedLeaderId],
  );
  const crawlOpen =
    latestCrawl !== null &&
    OPEN_BOT_COMMAND_STATUSES.includes(latestCrawl.status);
  // Requesting covers the gap between the click and the server answering, so
  // the button can't be pressed twice on a slow connection.
  const crawling = crawlRequesting || crawlOpen;

  async function handleCrawl() {
    setCrawlRequesting(true);
    const res = await requestBankCrawl({ company_entity_id: selectedCompanyId });
    setCrawlRequesting(false);
    if (!res.ok) {
      toast.error(res.error ?? "Couldn't request a bank crawl");
      return;
    }
    if (res.deduped) {
      toast.info("A bank crawl is already in progress");
      return;
    }
    if (!res.agentOnline) {
      // Queued all the same — but say so, rather than letting someone watch a
      // spinner that nothing is listening to.
      toast.warning(
        "Crawl queued, but no agent is online. It runs as soon as one is back, or expires in 10 minutes.",
      );
      return;
    }
    toast.success("Bank crawl requested — the agent picks it up within ~30s");
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
      "Sender",
      "Deposit Amount",
      "Bank",
      "Account Holder",
      "Account Number",
      "Bonus",
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
      extractSenderName(d.bank_description) ?? "",
      d.deposit_amount.toFixed(2),
      d.bank_name,
      d.bank_account_holder ?? "",
      d.bank_account_number ?? "",
      bonusPlanById(d.bonus_plan_id)?.name ?? "",
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
            Agent-detected bank transactions — approve, then the agent tops up the game
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
            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
              {pendingCount} pending approval
            </div>
          )}
          {!isViewer && (
            <>
              <Button
                variant="outline"
                onClick={handleCrawl}
                disabled={crawling}
                title={crawlHint(latestCrawl)}
                className="cursor-pointer"
              >
                {crawling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Radar className="h-3.5 w-3.5" />
                )}
                {crawling
                  ? latestCrawl?.status === "running"
                    ? "Crawling…"
                    : "Queued…"
                  : "Crawl banks"}
              </Button>
              <Button
                onClick={() => setManualDepositOpen(true)}
                className="cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                Manual deposit
              </Button>
            </>
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
          <Select
            value={sourceFilter}
            onValueChange={(v) => setSourceFilter(v ?? "all")}
            items={[
              { value: "all", label: "All sources" },
              { value: "bot", label: "Auto" },
              { value: "manual", label: "Manual" },
            ]}
          >
            <SelectTrigger className="h-8 w-[120px] cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="bot">Auto</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
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
                  onClick={() => setConfirmBulk(true)}
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
                <th className="px-3 py-2.5 text-left font-medium">When</th>
                <th className="px-3 py-2.5 text-left font-medium">Bank</th>
                <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-left font-medium">Player</th>
                <th className="px-3 py-2.5 text-left font-medium">Bonus</th>
                <th className="px-3 py-2.5 text-left font-medium">Game</th>
              </tr>
            </thead>
            <AnimatePresence initial={false}>
              {filtered.map((d) => {
                const actionable = d.status === "pending" || d.status === "matched";
                const editable = actionable && !isViewer;
                const isMine = d.assigned_to_user_id === me?.user_id;
                const canApprove =
                  editable && d.player_id !== null && !!d.selected_game && isMine;
                const approveHint = !editable
                  ? undefined
                  : !isMine
                    ? d.assigned_to_user_id
                      ? "Handled by someone else"
                      : "Assign this deposit to yourself first"
                    : d.player_id === null
                      ? "Assign a player first"
                      : !d.selected_game
                        ? "Select a game first"
                        : undefined;
                const sender = extractSenderName(d.bank_description);
                return (
                  // One deposit is two rows, so the group is a tbody of its own
                  // — that keeps the enter/exit animation on the whole item and
                  // lets the remark row span the full width beneath the detail
                  // row instead of fighting it for horizontal space.
                  <motion.tbody
                    key={d.deposit_id}
                    layout
                    initial={d.is_new ? { opacity: 0, y: -12, backgroundColor: "rgba(16,185,129,0.15)" } : false}
                    animate={{ opacity: 1, y: 0, backgroundColor: "rgba(0,0,0,0)" }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.45 }}
                    className={cn(
                      "border-t-2 align-middle",
                      selectedIds.has(d.deposit_id) && editable
                        ? "bg-primary/5 hover:bg-primary/10"
                        : editable
                          ? "bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-50"
                          : "hover:bg-muted/30",
                    )}
                  >
                    <tr className="align-top">
                      {!isViewer && (
                        <td className="px-3 pt-2.5 pb-2.5">
                          <div className="flex min-h-7 items-center">
                          <input
                            type="checkbox"
                            aria-label={`Select deposit ${d.transaction_ref}`}
                            checked={editable && selectedIds.has(d.deposit_id)}
                            onChange={() => toggleRow(d.deposit_id)}
                            disabled={!editable || bulkApproving}
                            className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-30"
                          />
                          </div>
                        </td>
                      )}
                      <td className="px-3 pt-2.5 pb-2.5 whitespace-nowrap">
                        <div className="flex min-h-7 items-center text-[12px] font-medium">
                          {formatShortDateTime(d.deposit_date)}
                        </div>
                      </td>
                      <td className="px-3 pt-2.5 pb-2.5">
                        <div className="flex min-h-7 flex-wrap items-center gap-x-2">
                        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap">
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
                          <span className="text-[11px] leading-tight">
                            {d.bank_account_holder}
                          </span>
                        )}
                        {d.bank_account_number && (
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {d.bank_account_number}
                          </span>
                        )}
                        </div>
                      </td>
                      {/* Deposit, bonus and total stacked in one column — three
                          separate ones were the widest part of the old row and
                          are only ever read together. */}
                      <td className="px-3 pt-2.5 pb-2.5 text-right whitespace-nowrap">
                        {/* Stacked, and the total carries the emphasis — it is
                            the figure that actually gets credited. */}
                        <div className="flex min-h-7 items-center justify-end font-medium">
                          {formatRM(d.deposit_amount)}
                        </div>
                        {d.bonus_amount > 0 && (
                          <>
                            <div className="text-[11px] text-muted-foreground">
                              + {formatRM(d.bonus_amount)} bonus
                            </div>
                            <div className="text-[13px] font-bold text-emerald-600 dark:text-emerald-400">
                              {formatRM(d.total_amount)}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="px-3 pt-2.5 pb-2.5">
                        <div className="flex min-h-7 items-center">
                          <StatusBadge status={d.status} />
                        </div>
                      </td>
                      <td className="px-3 pt-2.5 pb-2.5">
                        <div className="flex min-h-7 flex-wrap items-center gap-1.5">
                          {d.player_id !== null ? (
                            <PlayerNameLink playerId={d.player_id}>
                              {d.player_username ?? `P-${d.player_id}`}
                            </PlayerNameLink>
                          ) : (
                            <span className="text-[12px] italic text-muted-foreground">
                              Unmatched
                            </span>
                          )}
                          {editable && (
                            <button
                              type="button"
                              onClick={() => setAssignTargets([d.deposit_id])}
                              title={d.player_id === null ? "Assign a player" : "Change the player"}
                              className="cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                            >
                              {d.player_id === null ? "assign" : "change"}
                            </button>
                          )}
                        </div>

                      </td>
                      <td className="px-3 pt-2.5 pb-2.5">
                        <div className="flex min-h-7 w-full items-center">
                        {editable ? (
                          <BonusPicker
                            playerId={d.player_id}
                            depositAmount={d.deposit_amount}
                            depositId={d.deposit_id}
                            planId={d.bonus_plan_id}
                            percentage={d.bonus_percentage}
                            overrideReason={d.bonus_override_reason}
                            className="w-full"
                            onPick={(choice) => handleDraft(d.deposit_id, choice)}
                          />
                        ) : (
                          <span className="text-[12px]">
                            {bonusPlanById(d.bonus_plan_id)?.name ?? "—"}
                            <span className="ml-1 text-muted-foreground">
                              {d.bonus_percentage}%
                            </span>
                          </span>
                        )}
                        </div>
                      </td>
                      <td className="px-3 pt-2.5 pb-2.5">
                        <div className="flex min-h-7 w-full items-center">
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
                                className="h-7 w-full px-2 text-[12px]"
                              />
                            );
                          })()
                        ) : (
                          <span className="text-[12px]">{d.selected_game ?? "—"}</span>
                        )}
                        </div>
                      </td>
                    </tr>

                    {/* Second row: how the deposit arrived — badges, reference,
                        then the bank remark in full — with every action on the
                        right. Indented past the checkbox so it lines up under
                        the When column, and set in its own card rather than
                        ruled off, so the pair reads as one item. */}
                    <tr>
                      {!isViewer && <td className="px-3" />}
                      <td colSpan={7} className="px-3 pb-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-muted/50 px-3 py-2">
                          <div className="min-w-0 flex-1 basis-[280px]">
                            <p className="text-[12px] leading-snug break-words">
                              <span className="mr-1.5 inline-flex items-center gap-1 align-middle">
                                <SourceBadge source={d.source} />
                                {d.skip_bot && (
                                  <span className="inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                    No agent
                                  </span>
                                )}
                              </span>
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {d.transaction_ref}
                              </span>
                              <span className="mx-1.5 text-muted-foreground">–</span>
                              {d.bank_description ? (
                                <>
                                  {sender && (
                                    <span
                                      className="mr-1.5 font-medium"
                                      title="Sender on the bank statement — the payment channel, not necessarily the player"
                                    >
                                      {sender}
                                    </span>
                                  )}
                                  <span className="italic text-muted-foreground">
                                    {d.bank_description}
                                  </span>
                                </>
                              ) : (
                                <span className="italic text-muted-foreground">
                                  {d.player_id === null
                                    ? "Unmatched deposit — no bank remark"
                                    : "No bank remark"}
                                </span>
                              )}
                            </p>
                          </div>

                          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                            {/* Who holds it sits with the actions, because
                                claiming is the first of them. */}
                            <AssigneeCell
                              kind="deposit"
                              id={d.deposit_id}
                              showLabel
                              assignedToUserId={d.assigned_to_user_id}
                              locked={!actionable}
                              lockedTitle="Approved deposits stay with whoever dispatched them"
                            />
                            {!isViewer &&
                            d.skip_bot &&
                            (d.status === "pending" || d.status === "matched") ? (
                              <>
                                <Button
                                  size="xs"
                                  onClick={() => setConfirmApproveId(d.deposit_id)}
                                  disabled={!canApprove}
                                  title={approveHint}
                                  className="cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/30 disabled:text-white/70"
                                >
                                  <Zap className="h-3 w-3" />
                                  Approve
                                </Button>
                                <RejectDepositButton onClick={() => setConfirmRejectId(d.deposit_id)} />
                              </>
                            ) : !isViewer && d.skip_bot && d.status === "processing" ? (
                              <>
                                <Button
                                  size="xs"
                                  onClick={async () => {
                                    const r = await completeDeposit(d.deposit_id);
                                    if (!r.ok) toast.error(r.error ?? "Complete failed");
                                    else toast.success("Deposit completed — credit booked");
                                  }}
                                  className="cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700"
                                >
                                  <CheckCircle2 className="h-3 w-3" />
                                  Complete
                                </Button>
                                <RejectDepositButton onClick={() => setConfirmRejectId(d.deposit_id)} />
                              </>
                            ) : actionable && !isViewer ? (
                              <Button
                                size="xs"
                                onClick={() => setConfirmApproveId(d.deposit_id)}
                                disabled={!canApprove}
                                title={approveHint}
                                className="cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/30 disabled:text-white/70"
                              >
                                <Zap className="h-3 w-3" />
                                Approve
                              </Button>
                            ) : d.status === "completed" ? (
                              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                                <CheckCircle2 className="h-3 w-3" />
                                Credited
                              </span>
                            ) : d.status === "processing" || d.status === "approved" ? (
                              <span className="inline-flex items-center gap-1 text-[11px] text-blue-700 dark:text-blue-300">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Agent topping up…
                              </span>
                            ) : d.status === "pending_match" ? (
                              <span className="text-[11px] text-muted-foreground">
                                Waiting for agent
                              </span>
                            ) : d.status === "failed" ? (
                              isViewer ? (
                                <span className="text-[11px] text-red-600 dark:text-red-400">Top-up failed</span>
                              ) : (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  className="cursor-pointer gap-1 border-red-300 text-red-700 dark:text-red-300 hover:bg-red-50 hover:text-red-800"
                                  onClick={async () => {
                                    const r = await reprocessDeposit(d.deposit_id);
                                    if (!r.ok) toast.error(r.error ?? "Reprocess failed");
                                    else toast.success("Deposit reopened — review and approve to retry");
                                  }}
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Reprocess
                                </Button>
                              )
                            ) : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  </motion.tbody>
                );
              })}
            </AnimatePresence>
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
                    Bank transactions detected by the agent will appear here
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
          <span>Connected: OpenClaw Agent · Auto-sync every 10s</span>
        </div>
      </Card>

      <ApprovalFlowModal
        depositId={approvingId}
        open={approvingId !== null}
        onOpenChange={(o) => !o && setApprovingId(null)}
      />

      {(() => {
        const d = depositById(confirmApproveId);
        return (
          <ConfirmActionDialog
            open={d !== undefined}
            onOpenChange={(o) => !o && setConfirmApproveId(null)}
            title="Approve this deposit?"
            description="The agent tops up the player's game account. Credit is only booked once it confirms."
            summary={d ? depositSummary(d) : []}
            confirmLabel="Approve"
            onConfirm={() => runApprove(d!.deposit_id)}
          />
        );
      })()}

      {(() => {
        const d = depositById(confirmRejectId);
        return (
          <ConfirmActionDialog
            open={d !== undefined}
            onOpenChange={(o) => !o && setConfirmRejectId(null)}
            title="Reject this deposit?"
            description="It is marked failed. No credit is given and nothing is reversed."
            summary={d ? depositSummary(d) : []}
            confirmLabel="Reject"
            tone="danger"
            onConfirm={() => runReject(d!.deposit_id)}
          />
        );
      })()}

      <ConfirmActionDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={`Approve ${approvable.length} deposit${approvable.length === 1 ? "" : "s"}?`}
        description="Each is dispatched to the agent for top-up, one after another."
        items={approvable.map((id) => {
          const dep = depositById(id);
          return {
            key: id,
            label: dep?.player_username ?? `Deposit #${id}`,
            meta: [
              dep?.selected_game,
              dep && dep.bonus_amount > 0
                ? `${formatRM(dep.deposit_amount)} + ${formatRM(dep.bonus_amount)}`
                : dep
                  ? formatRM(dep.deposit_amount)
                  : null,
            ]
              .filter(Boolean)
              .join(" · "),
            value: formatRM(dep?.total_amount ?? 0),
          };
        })}
        onRemoveItem={(key) =>
          setSelectedIds((prev) => {
            const next = new Set(prev);
            next.delete(Number(key));
            return next;
          })
        }
        summary={[
          {
            label: `${approvable.length} deposit${approvable.length === 1 ? "" : "s"} · ${
              new Set(
                approvable
                  .map((id) => depositById(id)?.player_id)
                  .filter((v) => v != null),
              ).size
            } player${
              new Set(
                approvable
                  .map((id) => depositById(id)?.player_id)
                  .filter((v) => v != null),
              ).size === 1
                ? ""
                : "s"
            }`,
            value: formatRM(
              approvable.reduce(
                (sum, id) => sum + (depositById(id)?.total_amount ?? 0),
                0,
              ),
            ),
            emphasis: true,
          },
        ]}
        confirmLabel={`Approve ${approvable.length}`}
        onConfirm={handleBulkApprove}
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

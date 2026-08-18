"use client";

import { useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { formatRM, formatShortDateTime, formatRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListLoading } from "@/components/list-loading";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge, SourceBadge } from "@/components/status-badge";
import { SearchableSelect } from "@/components/searchable-select";
import { AssigneeCell } from "@/components/assignee-cell";
import { PlayerNameLink } from "@/components/player-name-link";
import { PullbackFlowModal } from "@/components/pullback-flow-modal";
import {
  ArrowDownToLine,
  Banknote,
  CheckCircle2,
  Loader2,
  Paperclip,
  Plus,
  Search,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PlayerPickerSheet } from "@/components/player-picker-sheet";
import {
  ConfirmActionDialog,
  type SummaryRow,
} from "@/components/confirm-action-dialog";

const STATUS_FILTERS: { value: string; tab: string }[] = [
  { value: "requested", tab: "Requested" },
  { value: "credits_pulled", tab: "Credits Pulled" },
  { value: "paid", tab: "Paid" },
  { value: "failed", tab: "Failed" },
  { value: "all", tab: "All" },
];

export default function WithdrawalsPage() {
  const withdrawals = useStore((s) => s.withdrawals);
  const hydrated = useStore((s) => s.hydrated);
  const players = useStore((s) => s.players);
  const bankAccounts = useStore((s) => s.bankAccounts);
  const getBalance = useStore((s) => s.getCreditBalance);
  const playerById = useStore((s) => s.playerById);
  const markPaid = useStore((s) => s.markWithdrawalPaid);
  const createWithdrawal = useStore((s) => s.createWithdrawal);
  const rejectWithdrawal = useStore((s) => s.rejectWithdrawal);
  const uploadFile = useStore((s) => s.uploadFile);
  const setAssignment = useStore((s) => s.setAssignment);
  const pullCredits = useStore((s) => s.pullCreditsForWithdrawal);
  const me = useStore((s) => s.me);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const companyInScope = useStore((s) => s.companyInScope);
  const companiesFn = useStore((s) => s.companies);

  const isViewer = me?.role === "viewer";

  const [pullingId, setPullingId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("requested");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkPulling, setBulkPulling] = useState(false);
  const [confirmRejectId, setConfirmRejectId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Agent-created vs hand-entered. Rows predating the column read as manual —
  // withdrawals have always been raised by CS unless the agent said otherwise.
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  // --- New Withdrawal dialog state ---
  const [newOpen, setNewOpen] = useState(false);
  const [newPlayerId, setNewPlayerId] = useState("");
  const [newGame, setNewGame] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newAll, setNewAll] = useState(false);
  const [newBankName, setNewBankName] = useState("");
  const [newBankAccount, setNewBankAccount] = useState("");
  const [newSkipBot, setNewSkipBot] = useState(false);
  const [playerPickerOpen, setPlayerPickerOpen] = useState(false);
  const [newSubmitting, setNewSubmitting] = useState(false);

  // --- Mark Paid dialog state ---
  const [payingId, setPayingId] = useState<number | null>(null);
  const [payoutAccountId, setPayoutAccountId] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [paySubmitting, setPaySubmitting] = useState(false);
  const proofInputRef = useRef<HTMLInputElement>(null);

  const scoped = useMemo(
    () =>
      withdrawals.filter((w) =>
        companyInScope(playerById(w.player_id)?.company_entity_id),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [withdrawals, selectedCompanyId, selectedLeaderId, playerById],
  );

  // Search applied first; the status tabs show counts from this set.
  const searched = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const bySource = scoped.filter(
      (w) => sourceFilter === "all" || (w.source ?? "manual") === sourceFilter,
    );
    if (!q) return bySource;
    return bySource.filter((w) => {
      const player = playerById(w.player_id);
      return [
        player?.full_name,
        player?.username,
        player?.telegram_username,
        w.game_name,
        w.bank_name,
        w.bank_account_number,
        String(w.requested_amount),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [scoped, searchQuery, sourceFilter, playerById]);

  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of searched) m.set(w.status, (m.get(w.status) ?? 0) + 1);
    return m;
  }, [searched]);

  const sorted = useMemo(
    () =>
      [...searched]
        .filter((w) => statusFilter === "all" || w.status === statusFilter)
        .sort((a, b) => {
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
    [searched, statusFilter],
  );

  const pending = scoped.filter(
    (w) => w.status === "requested" || w.status === "credits_pulled",
  ).length;
  const activeCompany = companiesFn().find(
    (c) => c.company_id === selectedCompanyId,
  );

  const eligiblePlayers = useMemo(
    () => players.filter((p) => companyInScope(p.company_entity_id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [players, selectedCompanyId, selectedLeaderId],
  );

  const payoutAccounts = bankAccounts.filter(
    (a) => a.role === "withdrawal" && a.status === "active",
  );

  const newPlayer = newPlayerId ? playerById(Number(newPlayerId)) : undefined;
  // Games the selected player has linked accounts for; none until a player is
  // picked. Sorted A–Z so the list is in the same order every time.
  const newGames = (newPlayer?.game_accounts ?? [])
    .map((g) => g.game_name)
    .sort((a, b) => a.localeCompare(b));
  const newBalance =
    newPlayer && newGame ? getBalance(newPlayer.player_id, newGame) : 0;
  // "Withdraw all" derives the amount from the live balance rather than
  // stamping it into the field, so switching game or a refreshed balance can't
  // leave a stale number behind.
  const newAmt = newAll ? newBalance : Number(newAmount) || 0;
  const newValid =
    !!newPlayer && !!newGame && newAmt > 0 && newAmt <= newBalance;

  // Only rows still needing work are worth claiming; a paid withdrawal has
  // nobody left to handle it.
  const selectableIds = useMemo(
    () =>
      isViewer
        ? []
        : sorted
            .filter(
              (w) => w.status === "requested" || w.status === "credits_pulled",
            )
            .map((w) => w.withdrawal_id),
    [sorted, isViewer],
  );
  // Drop anything that left the filter since it was ticked.
  const selected = useMemo(
    () => selectableIds.filter((id) => selectedIds.has(id)),
    [selectableIds, selectedIds],
  );
  // Pulling needs the claim (the server enforces it), so the bulk button only
  // counts rows you hold that are still awaiting a pull.
  const pullable = useMemo(
    () =>
      sorted
        .filter(
          (w) =>
            selected.includes(w.withdrawal_id) &&
            w.status === "requested" &&
            w.assigned_to_user_id === me?.user_id,
        )
        .map((w) => w.withdrawal_id),
    [sorted, selected, me?.user_id],
  );

  function toggleRow(withdrawalId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(withdrawalId)) next.delete(withdrawalId);
      else next.add(withdrawalId);
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

  /** Claim every selected withdrawal that isn't already someone else's. */
  async function handleBulkAssign() {
    if (selected.length === 0 || bulkAssigning) return;
    setBulkAssigning(true);
    const res = await setAssignment({ kind: "withdrawal", ids: selected });
    setBulkAssigning(false);
    if (!res.ok) {
      toast.error(res.error ?? "Could not assign");
      return;
    }
    toast.success(
      `${res.changed} withdrawal${res.changed === 1 ? "" : "s"} assigned to you`,
    );
    if (res.skipped) {
      toast.warning(`${res.skipped} skipped — already assigned to someone else`);
    }
    setSelectedIds(new Set());
  }

  /**
   * Pull every selected withdrawal you hold. Runs the plain store action rather
   * than the pull-back modal — that animation is a per-row confirmation and
   * would be nonsense twenty times over.
   */
  async function handleBulkPull() {
    if (pullable.length === 0 || bulkPulling) return;
    setBulkPulling(true);
    let ok = 0;
    let failed = 0;
    for (const id of pullable) {
      const res = await pullCredits(id);
      if (res.ok) ok += 1;
      else failed += 1;
    }
    setBulkPulling(false);
    setSelectedIds(new Set());
    if (ok > 0)
      toast.success(`Credits pulled for ${ok} withdrawal${ok === 1 ? "" : "s"}`);
    if (failed > 0)
      toast.error(`${failed} withdrawal${failed === 1 ? "" : "s"} failed to pull`);
  }

  /** What the confirm dialog restates back before rejecting. */
  function withdrawalSummary(w: (typeof withdrawals)[number]): SummaryRow[] {
    const player = playerById(w.player_id);
    return [
      { label: "Player", value: player?.full_name ?? `P-${w.player_id}` },
      { label: "Member code", value: player?.username ?? "—" },
      { label: "Game", value: w.game_name },
      {
        label: "Pay to",
        value: w.bank_name
          ? `${w.bank_name}${w.bank_account_number ? ` · ${w.bank_account_number}` : ""}`
          : "—",
      },
      { label: "Requested", value: formatRM(w.requested_amount), emphasis: true },
    ];
  }

  async function runReject(withdrawalId: number) {
    const r = await rejectWithdrawal(withdrawalId);
    if (!r.ok) toast.error(r.error ?? "Reject failed");
    else toast.success("Withdrawal rejected");
    setConfirmRejectId(null);
  }

  function resetNewForm() {
    setNewPlayerId("");
    setNewGame("");
    setNewAmount("");
    setNewAll(false);
    setNewBankName("");
    setNewBankAccount("");
    setNewSkipBot(false);
  }

  async function handleCreateWithdrawal() {
    if (!newPlayer || !newValid || newSubmitting) return;
    setNewSubmitting(true);
    const res = await createWithdrawal({
      player_id: newPlayer.player_id,
      requested_amount: newAmt,
      game_name: newGame,
      bank_name: newBankName.trim() || undefined,
      bank_account_number: newBankAccount.trim() || undefined,
      skip_bot: newSkipBot,
    });
    setNewSubmitting(false);
    if (!res.ok) {
      toast.error(res.error ?? "Failed to create withdrawal");
      return;
    }
    toast.success("Withdrawal request created");
    resetNewForm();
    setNewOpen(false);
  }

  function resetPayForm() {
    setPayoutAccountId("");
    setProofFile(null);
  }

  async function handleMarkPaid() {
    if (payingId === null || paySubmitting) return;
    setPaySubmitting(true);
    let proofUrl: string | undefined;
    if (proofFile) {
      const up = await uploadFile(proofFile);
      if (!up.ok) {
        setPaySubmitting(false);
        toast.error(up.error ?? "Proof upload failed");
        return;
      }
      proofUrl = up.url;
    }
    const res = await markPaid(payingId, {
      paid_from_account_id: payoutAccountId
        ? Number(payoutAccountId)
        : undefined,
      proof_url: proofUrl,
    });
    setPaySubmitting(false);
    if (!res.ok) {
      toast.error(res.error ?? "Failed to mark withdrawal as paid");
      return;
    }
    resetPayForm();
    setPayingId(null);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Withdrawals</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Requests received via Telegram/WeChat — pull credits from game, then pay out
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
          {pending > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              {pending} awaiting action
            </div>
          )}
          {!isViewer && (
            <Button
              size="sm"
              onClick={() => setNewOpen(true)}
              className="cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              New Withdrawal
            </Button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
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
              placeholder="Search player, game, bank, amount…"
              className="h-8 w-[240px] pl-8"
            />
          </div>
          {selected.length > 0 && (
            <div className="ml-auto flex items-center gap-1.5">
              <span className="mr-1 text-[11px] font-medium">
                {selected.length} selected
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleBulkAssign()}
                disabled={bulkAssigning || bulkPulling}
                title="Claim these so other agents can see you're on them"
                className="cursor-pointer"
              >
                {bulkAssigning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UserCheck className="h-3.5 w-3.5" />
                )}
                Assign to me
              </Button>
              <Button
                size="sm"
                onClick={() => void handleBulkPull()}
                disabled={pullable.length === 0 || bulkAssigning || bulkPulling}
                title={
                  pullable.length === 0
                    ? "Assign these to yourself first — only requested withdrawals you hold can be pulled"
                    : undefined
                }
                className="cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/30 disabled:text-white/70"
              >
                {bulkPulling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                )}
                Pull Credits ({pullable.length})
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
                disabled={bulkAssigning || bulkPulling}
                className="cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </Button>
            </div>
          )}
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
                      aria-label="Select all actionable withdrawals"
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
                      disabled={selectableIds.length === 0 || bulkPulling}
                      className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                    />
                  </th>
                )}
                <th className="px-3 py-2.5 text-left font-medium">When</th>
                <th className="px-3 py-2.5 text-left font-medium">Player</th>
                <th className="px-3 py-2.5 text-left font-medium">Game</th>
                <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                <th className="px-3 py-2.5 text-right font-medium">Pulled</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
              </tr>
            </thead>
            {sorted.length === 0 && (
              <tbody>
                <tr className="border-t">
                  <td
                    colSpan={isViewer ? 6 : 7}
                    className="px-3 py-10 text-center text-sm text-muted-foreground"
                  >
                    {!hydrated ? (
                      <ListLoading className="py-0" label="Loading withdrawals…" />
                    ) : scoped.length === 0 ? (
                      `No withdrawal requests yet${activeCompany ? ` for ${activeCompany.company_name}` : ""}.`
                    ) : (
                      "No withdrawals match the current search and filters."
                    )}
                  </td>
                </tr>
              </tbody>
            )}
            {sorted.map((w) => {
              const player = playerById(w.player_id);
              const bal = getBalance(w.player_id, w.game_name);
              // Withdrawals record only the bank and account number — the
              // holder's name lives on the player's saved accounts, so match it
              // back by account number (falling back to the bank).
              const payoutAccount =
                player?.bank_accounts?.find(
                  (b) => b.account_number === w.bank_account_number,
                ) ??
                player?.bank_accounts?.find((b) => b.bank_name === w.bank_name);
              const isMine = w.assigned_to_user_id === me?.user_id;
              // Pulling needs the claim, same as approving a deposit.
              const canPull = !isViewer && w.status === "requested" && isMine;
              const showPull = !isViewer && w.status === "requested";
              const pullHint = !isMine
                ? w.assigned_to_user_id
                  ? "Handled by someone else"
                  : "Assign this withdrawal to yourself first"
                : undefined;
              const canPay = !isViewer && w.status === "credits_pulled";
              const selectable =
                !isViewer &&
                (w.status === "requested" || w.status === "credits_pulled");
              return (
                // One withdrawal is two rows — detail above, how-it-pays and the
                // actions below — so the group is a tbody of its own.
                <tbody
                  key={w.withdrawal_id}
                  className={cn(
                    "border-t-2 align-middle",
                    selectedIds.has(w.withdrawal_id) && selectable
                      ? "bg-primary/5 hover:bg-primary/10"
                      : "hover:bg-muted/30",
                  )}
                >
                  <tr className="align-top">
                    {!isViewer && (
                      <td className="px-3 pt-2.5 pb-2.5">
                        <div className="flex min-h-7 items-center">
                          <input
                            type="checkbox"
                            aria-label={`Select withdrawal ${w.withdrawal_id}`}
                            checked={selectable && selectedIds.has(w.withdrawal_id)}
                            onChange={() => toggleRow(w.withdrawal_id)}
                            disabled={!selectable || bulkAssigning}
                            className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-30"
                          />
                        </div>
                      </td>
                    )}
                    <td className="px-3 pt-2.5 pb-2.5 whitespace-nowrap">
                      <div className="flex min-h-7 flex-wrap items-center gap-x-2">
                        <span className="text-[12px] font-medium">
                          {formatShortDateTime(w.created_at)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatRelative(w.created_at)}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 pt-2.5 pb-2.5">
                      <div className="flex min-h-7 flex-wrap items-center gap-x-2">
                        <PlayerNameLink playerId={w.player_id}>
                          {player?.username ?? `P-${w.player_id}`}
                        </PlayerNameLink>
                        <span className="text-[10px] text-muted-foreground">
                          {player?.telegram_username ?? "—"}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 pt-2.5 pb-2.5">
                      <div className="flex min-h-7 flex-wrap items-center gap-x-2">
                        <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap">
                          {w.game_name}
                        </span>
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                          bal {formatRM(bal)}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 pt-2.5 pb-2.5 text-right whitespace-nowrap">
                      <div className="flex min-h-7 items-center justify-end font-semibold">
                        {formatRM(w.requested_amount)}
                      </div>
                    </td>
                    <td className="px-3 pt-2.5 pb-2.5 text-right whitespace-nowrap">
                      <div className="flex min-h-7 items-center justify-end">
                        {w.credit_pulled_amount > 0 ? (
                          <span className="text-blue-700 dark:text-blue-400">
                            {formatRM(w.credit_pulled_amount)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 pt-2.5 pb-2.5">
                      <div className="flex min-h-7 items-center">
                        <StatusBadge status={w.status} />
                      </div>
                    </td>
                  </tr>

                  {/* Second row: how it was raised and where it pays out, with
                      every action on the right. Indented past the checkbox so it
                      lines up under When. */}
                  <tr>
                    {!isViewer && <td className="px-3" />}
                    <td colSpan={6} className="px-3 pb-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-muted/50 px-3 py-2">
                        <div className="min-w-0 flex-1 basis-[280px]">
                          <p className="text-[12px] leading-snug break-words">
                            <span className="mr-1.5 inline-flex items-center gap-1 align-middle">
                              <SourceBadge source={w.source} />
                              {w.skip_bot && (
                                <span className="inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                  No agent
                                </span>
                              )}
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              W-{w.withdrawal_id}
                            </span>
                            <span className="mx-1.5 text-muted-foreground">–</span>
                            {w.bank_name || w.bank_account_number ? (
                              <>
                                <span className="font-medium">{w.bank_name ?? "Bank"}</span>
                                {payoutAccount?.account_holder && (
                                  <span className="ml-1.5">
                                    {payoutAccount.account_holder}
                                  </span>
                                )}
                                {w.bank_account_number && (
                                  <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                                    {w.bank_account_number}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="italic text-muted-foreground">
                                No payout bank on file
                              </span>
                            )}
                          </p>
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          {/* Who holds it sits with the actions, because
                              claiming is the first of them. */}
                          <AssigneeCell
                            kind="withdrawal"
                            id={w.withdrawal_id}
                            showLabel
                            assignedToUserId={w.assigned_to_user_id}
                          />
                          {showPull && (
                            <>
                              <Button
                                size="xs"
                                onClick={() => setPullingId(w.withdrawal_id)}
                                disabled={!canPull}
                                title={pullHint}
                                className="cursor-pointer bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-600/30 disabled:text-white/70"
                              >
                                <ArrowDownToLine className="h-3 w-3" />
                                Pull Credits
                              </Button>
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => setConfirmRejectId(w.withdrawal_id)}
                                className="cursor-pointer gap-1 border-red-300 text-red-700 dark:text-red-300 hover:bg-red-50 hover:text-red-800"
                              >
                                <X className="h-3 w-3" />
                                Reject
                              </Button>
                            </>
                          )}
                          {canPay && (
                            <Button
                              size="xs"
                              variant="outline"
                              className="cursor-pointer"
                              onClick={() => {
                                resetPayForm();
                                setPayingId(w.withdrawal_id);
                              }}
                            >
                              <Banknote className="h-3 w-3" />
                              Mark Paid
                            </Button>
                          )}
                          {w.status === "paid" && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                              <CheckCircle2 className="h-3 w-3" />
                              Sent
                              {w.proof_url && (
                                <a
                                  href={w.proof_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                                  title="Proof of payment"
                                >
                                  <Paperclip className="h-3 w-3" />
                                </a>
                              )}
                            </span>
                          )}
                          {w.status === "failed" && (
                            <span className="text-[11px] text-red-600 dark:text-red-400">Failed</span>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                </tbody>
              );
            })}
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

      {/* New Withdrawal dialog */}
      <Dialog
        open={newOpen}
        onOpenChange={(o) => {
          if (!newSubmitting) {
            setNewOpen(o);
            if (!o) resetNewForm();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New withdrawal request</DialogTitle>
            <DialogDescription>
              Record a withdrawal request on behalf of a player
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Player</Label>
              <button
                type="button"
                onClick={() => setPlayerPickerOpen(true)}
                className="flex h-9 w-full cursor-pointer items-center justify-between rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors hover:bg-muted/40 focus:border-ring focus:ring-2 focus:ring-ring/30"
              >
                {newPlayer ? (
                  <span className="truncate">
                    {newPlayer.full_name}{" "}
                    <span className="text-muted-foreground">
                      @{newPlayer.username}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Select player</span>
                )}
                <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
              {eligiblePlayers.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  No players available — create a player first.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Game</Label>
              <SearchableSelect
                value={newGame || null}
                onValueChange={(v) => setNewGame(v)}
                options={newGames}
                placeholder="Select game"
                emptyMessage={
                  newPlayer
                    ? "No games linked to this player"
                    : "Select a player first"
                }
                searchPlaceholder="Search game…"
              />
              {newPlayer && newGame && (
                <p className="text-[11px] text-muted-foreground">
                  Current {newGame} balance:{" "}
                  <span className="font-medium">{formatRM(newBalance)}</span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="wd-amount">Requested amount (RM)</Label>
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground select-none">
                  <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={newAll}
                    disabled={!newPlayer || !newGame || newBalance <= 0}
                    onChange={(e) => setNewAll(e.target.checked)}
                  />
                  Withdraw all
                </label>
              </div>
              <Input
                id="wd-amount"
                type="number"
                value={newAll ? newBalance.toFixed(2) : newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                disabled={newAll}
                placeholder="0.00"
                min={0}
                max={newBalance}
              />
              {newPlayer && newGame && newAmt > newBalance && (
                <p className="text-[11px] text-red-600 dark:text-red-400">
                  Exceeds current {newGame} balance
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="wd-bank">Player bank (optional)</Label>
                <Input
                  id="wd-bank"
                  value={newBankName}
                  onChange={(e) => setNewBankName(e.target.value)}
                  placeholder="Maybank"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wd-acct">Account number (optional)</Label>
                <Input
                  id="wd-acct"
                  value={newBankAccount}
                  onChange={(e) => setNewBankAccount(e.target.value)}
                  placeholder="5128 4471 9023"
                  inputMode="numeric"
                />
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/40 p-3 select-none">
              <input
                type="checkbox"
                checked={newSkipBot}
                onChange={(e) => setNewSkipBot(e.target.checked)}
                className="mt-0.5 h-4 w-4 cursor-pointer accent-amber-600"
              />
              <span>
                <span className="block text-sm font-medium">
                  Handle manually (skip agent)
                </span>
                <span className="block text-[11px] text-muted-foreground mt-0.5">
                  The agent won&apos;t auto-process this — you pull credits and mark
                  paid (or reject) yourself.
                </span>
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setNewOpen(false)}
              disabled={newSubmitting}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateWithdrawal}
              disabled={!newValid || newSubmitting}
              className="cursor-pointer"
            >
              {newSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {(() => {
        const w = withdrawals.find((x) => x.withdrawal_id === confirmRejectId);
        return (
          <ConfirmActionDialog
            open={w !== undefined}
            onOpenChange={(o) => !o && setConfirmRejectId(null)}
            title="Reject this withdrawal?"
            description="It is marked failed. No credit is pulled and the player is not paid."
            summary={w ? withdrawalSummary(w) : []}
            confirmLabel="Reject"
            tone="danger"
            onConfirm={() => runReject(w!.withdrawal_id)}
          />
        );
      })()}

      <PlayerPickerSheet
        open={playerPickerOpen}
        onOpenChange={setPlayerPickerOpen}
        players={eligiblePlayers}
        title="Select player"
        description="Choose the player requesting the withdrawal"
        onSelect={(p) => {
          setNewPlayerId(String(p.player_id));
          setNewGame(""); // reset game — options depend on the player
        }}
      />

      {/* Mark Paid dialog */}
      <Dialog
        open={payingId !== null}
        onOpenChange={(o) => {
          if (!o && !paySubmitting) {
            setPayingId(null);
            resetPayForm();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark withdrawal as paid</DialogTitle>
            <DialogDescription>
              Confirm the bank payout has been sent to the player
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Deduct from payout account (optional)</Label>
              <Select
                value={payoutAccountId}
                onValueChange={(v) => setPayoutAccountId(v ?? "")}
                items={payoutAccounts.map((a) => ({
                  value: String(a.account_id),
                  label: `${a.bank_name} · ${a.label ?? a.account_number}`,
                }))}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue placeholder="No account deduction" />
                </SelectTrigger>
                <SelectContent>
                  {payoutAccounts.map((a) => (
                    <SelectItem key={a.account_id} value={String(a.account_id)}>
                      {a.bank_name} ·{" "}
                      {a.label ?? a.account_number} ({formatRM(a.current_balance)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {payoutAccounts.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  No active withdrawal accounts configured.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Proof of payment (optional)</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => proofInputRef.current?.click()}
                  className="cursor-pointer"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {proofFile ? "Change file" : "Attach file"}
                </Button>
                {proofFile && (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {proofFile.name}
                  </span>
                )}
              </div>
              <input
                ref={proofInputRef}
                type="file"
                accept="image/*,.pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setProofFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPayingId(null)}
              disabled={paySubmitting}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              onClick={handleMarkPaid}
              disabled={paySubmitting}
              className="cursor-pointer"
            >
              {paySubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <Banknote className="h-3.5 w-3.5" />
              Mark Paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

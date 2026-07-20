"use client";

import { useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { formatRM, formatDateTime, formatRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { StatusBadge } from "@/components/status-badge";
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
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const STATUS_FILTERS: { value: string; tab: string }[] = [
  { value: "requested", tab: "Requested" },
  { value: "credits_pulled", tab: "Credits Pulled" },
  { value: "paid", tab: "Paid" },
  { value: "failed", tab: "Failed" },
  { value: "all", tab: "All" },
];

export default function WithdrawalsPage() {
  const withdrawals = useStore((s) => s.withdrawals);
  const players = useStore((s) => s.players);
  const bankAccounts = useStore((s) => s.bankAccounts);
  const getBalance = useStore((s) => s.getCreditBalance);
  const playerById = useStore((s) => s.playerById);
  const gamesFn = useStore((s) => s.games);
  const markPaid = useStore((s) => s.markWithdrawalPaid);
  const createWithdrawal = useStore((s) => s.createWithdrawal);
  const uploadFile = useStore((s) => s.uploadFile);
  const me = useStore((s) => s.me);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const companiesFn = useStore((s) => s.companies);

  const isViewer = me?.role === "viewer";
  const games = gamesFn();

  const [pullingId, setPullingId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("requested");
  const [searchQuery, setSearchQuery] = useState("");

  // --- New Withdrawal dialog state ---
  const [newOpen, setNewOpen] = useState(false);
  const [newPlayerId, setNewPlayerId] = useState("");
  const [newGame, setNewGame] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newBankName, setNewBankName] = useState("");
  const [newBankAccount, setNewBankAccount] = useState("");
  const [newSubmitting, setNewSubmitting] = useState(false);

  // --- Mark Paid dialog state ---
  const [payingId, setPayingId] = useState<number | null>(null);
  const [payoutAccountId, setPayoutAccountId] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [paySubmitting, setPaySubmitting] = useState(false);
  const proofInputRef = useRef<HTMLInputElement>(null);

  const scoped = useMemo(
    () =>
      withdrawals.filter(
        (w) =>
          selectedCompanyId === null ||
          playerById(w.player_id)?.company_entity_id === selectedCompanyId,
      ),
    [withdrawals, selectedCompanyId, playerById],
  );

  // Search applied first; the status tabs show counts from this set.
  const searched = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((w) => {
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
  }, [scoped, searchQuery, playerById]);

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
    () =>
      players.filter(
        (p) =>
          selectedCompanyId === null ||
          p.company_entity_id === selectedCompanyId,
      ),
    [players, selectedCompanyId],
  );

  const payoutAccounts = bankAccounts.filter(
    (a) => a.role === "withdrawal" && a.status === "active",
  );

  const newPlayer = newPlayerId ? playerById(Number(newPlayerId)) : undefined;
  const newBalance =
    newPlayer && newGame ? getBalance(newPlayer.player_id, newGame) : 0;
  const newAmt = Number(newAmount) || 0;
  const newValid =
    !!newPlayer && !!newGame && newAmt > 0 && newAmt <= newBalance;

  function resetNewForm() {
    setNewPlayerId("");
    setNewGame("");
    setNewAmount("");
    setNewBankName("");
    setNewBankAccount("");
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
            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700">
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
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search player, game, bank, amount…"
              className="h-8 w-[240px] pl-8"
            />
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
              {sorted.length === 0 && (
                <tr className="border-t">
                  <td
                    colSpan={8}
                    className="px-3 py-10 text-center text-sm text-muted-foreground"
                  >
                    {scoped.length === 0
                      ? `No withdrawal requests yet${activeCompany ? ` for ${activeCompany.company_name}` : ""}.`
                      : "No withdrawals match the current search and filters."}
                  </td>
                </tr>
              )}
              {sorted.map((w) => {
                const player = playerById(w.player_id);
                const bal = getBalance(w.player_id, w.game_name);
                const canPull = !isViewer && w.status === "requested";
                const canPay = !isViewer && w.status === "credits_pulled";
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
                          className="cursor-pointer bg-blue-600 text-white hover:bg-blue-700"
                        >
                          <ArrowDownToLine className="h-3.5 w-3.5" />
                          Pull Credits
                        </Button>
                      )}
                      {canPay && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="cursor-pointer"
                          onClick={() => {
                            resetPayForm();
                            setPayingId(w.withdrawal_id);
                          }}
                        >
                          <Banknote className="h-3.5 w-3.5" />
                          Mark Paid
                        </Button>
                      )}
                      {w.status === "paid" && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Sent
                          {w.proof_url && (
                            <a
                              href={w.proof_url}
                              target="_blank"
                              rel="noreferrer"
                              className="cursor-pointer text-muted-foreground hover:text-foreground"
                              title="Proof of payment"
                            >
                              <Paperclip className="h-3.5 w-3.5" />
                            </a>
                          )}
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
              <Select value={newPlayerId} onValueChange={(v) => setNewPlayerId(v ?? "")}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue placeholder="Select player" />
                </SelectTrigger>
                <SelectContent>
                  {eligiblePlayers.map((p) => (
                    <SelectItem key={p.player_id} value={String(p.player_id)}>
                      {p.full_name} (@{p.username})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {eligiblePlayers.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  No players available — create a player first.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Game</Label>
              <Select value={newGame} onValueChange={(v) => setNewGame(v ?? "")}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue placeholder="Select game" />
                </SelectTrigger>
                <SelectContent>
                  {games.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {newPlayer && newGame && (
                <p className="text-[11px] text-muted-foreground">
                  Current {newGame} balance:{" "}
                  <span className="font-medium">{formatRM(newBalance)}</span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wd-amount">Requested amount (RM)</Label>
              <Input
                id="wd-amount"
                type="number"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                placeholder="0.00"
                min={0}
                max={newBalance}
              />
              {newPlayer && newGame && newAmt > newBalance && (
                <p className="text-[11px] text-red-600">
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

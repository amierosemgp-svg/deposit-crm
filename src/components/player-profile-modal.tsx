"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useStore } from "@/lib/store";
import { formatRM, formatShortDateTime, formatRelative, initialsOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "./status-badge";
import { GameAccountHistory } from "./game-account-history";
import { AutoAssignGameButton } from "./auto-assign-game-button";
import { PlayerTransactionsTab } from "./player-transactions-tab";
import { ReferralTab } from "./referral-tab";
import { ReferralBonusTab } from "./referral-bonus-tab";
import { Separator } from "@/components/ui/separator";
import {
  Send,
  MessageCircle,
  Phone,
  Calendar,
  Landmark,
  Gamepad2,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  User,
  Wallet,
  Receipt,
  StickyNote,
  Network,
  Gift,
} from "lucide-react";

type Props = {
  playerId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const EMPTY_BANK = { bank_name: "", account_number: "", account_holder: "" };
const EMPTY_GAME = { game_name: "", game_username: "" };

const SECTIONS = [
  { id: "profile", label: "Profile", icon: User },
  { id: "balances", label: "Game Balances", icon: Wallet },
  { id: "transactions", label: "Transactions", icon: Receipt },
  { id: "banks", label: "Bank Accounts", icon: Landmark },
  { id: "games", label: "Game Accounts", icon: Gamepad2 },
  { id: "referrals", label: "Referrals", icon: Network },
  { id: "recommend-bonus", label: "Recommend Bonus", icon: Gift },
  { id: "notes", label: "Notes", icon: StickyNote },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function PlayerProfileModal({ playerId, open, onOpenChange }: Props) {
  const [section, setSection] = useState<SectionId>("profile");
  const player = useStore((s) =>
    playerId ? s.players.find((p) => p.player_id === playerId) : undefined,
  );
  const gameCredits = useStore((s) => s.gameCredits);
  const deposits = useStore((s) => s.deposits);
  const withdrawals = useStore((s) => s.withdrawals);
  const me = useStore((s) => s.me);
  const entityName = useStore((s) => s.entityName);
  const gamesFn = useStore((s) => s.games);
  const banksFn = useStore((s) => s.banks);
  const updatePlayer = useStore((s) => s.updatePlayer);

  const isViewer = me?.role === "viewer";
  const banks = banksFn();

  const [notesDraft, setNotesDraft] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);

  const [bankFormOpen, setBankFormOpen] = useState(false);
  const [bankForm, setBankForm] = useState(EMPTY_BANK);
  const [savingBank, setSavingBank] = useState(false);
  // Index into player.bank_accounts being edited, or null when adding.
  const [editingBank, setEditingBank] = useState<number | null>(null);
  const [gameFormOpen, setGameFormOpen] = useState(false);
  const [gameForm, setGameForm] = useState(EMPTY_GAME);
  const [savingGame, setSavingGame] = useState(false);
  // Bumped after any game-account write so the history list refetches.
  const [gameAuditVersion, setGameAuditVersion] = useState(0);
  // Index into player.game_accounts being edited, or null when adding.
  const [editingGame, setEditingGame] = useState<number | null>(null);

  // Reset drafts whenever a different player is opened (state-during-render reset).
  const [prevResetKey, setPrevResetKey] = useState("");
  const resetKey = `${playerId ?? "none"}:${open}`;
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setNotesDraft(player?.notes ?? "");
    setBankFormOpen(false);
    setBankForm(EMPTY_BANK);
    setSavingBank(false);
    setEditingBank(null);
    setGameFormOpen(false);
    setGameForm(EMPTY_GAME);
    setSavingGame(false);
    setEditingGame(null);
  }

  const playerCredits = gameCredits.filter((c) => c.player_id === playerId);
  const gameNames = Array.from(
    new Set([...gamesFn(), ...playerCredits.map((c) => c.game_name)]),
  );
  const playerDeposits = deposits
    .filter((d) => d.player_id === playerId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8);
  const playerWithdrawals = withdrawals
    .filter((w) => w.player_id === playerId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8);

  // Profit for this player = deposits − withdrawals − bonuses (failed excluded).
  // Expenses aren't attributable to a player, so they're not subtracted here.
  const nonFailedDeposits = deposits.filter(
    (d) => d.player_id === playerId && d.status !== "failed",
  );
  const nonFailedWithdrawals = withdrawals.filter(
    (w) => w.player_id === playerId && w.status !== "failed",
  );
  const playerProfit =
    nonFailedDeposits.reduce((s, d) => s + d.deposit_amount, 0) -
    nonFailedWithdrawals.reduce((s, w) => s + w.requested_amount, 0) -
    nonFailedDeposits.reduce((s, d) => s + d.bonus_amount, 0);

  const notesDirty = (player?.notes ?? "") !== notesDraft;

  const bankFormValid =
    bankForm.bank_name !== "" && bankForm.account_number.trim() !== "";
  const gameFormValid =
    gameForm.game_name !== "" && gameForm.game_username.trim() !== "";

  async function saveBankAccount() {
    if (!player || !bankFormValid || savingBank) return;
    setSavingBank(true);
    const entry = {
      bank_name: bankForm.bank_name,
      account_number: bankForm.account_number.trim(),
      account_holder: bankForm.account_holder.trim() || player.full_name,
    };
    const list = player.bank_accounts ?? [];
    const res = await updatePlayer(player.player_id, {
      bank_accounts:
        editingBank === null
          ? [...list, entry]
          : list.map((b, i) => (i === editingBank ? entry : b)),
    });
    setSavingBank(false);
    if (res.ok) {
      toast.success(editingBank === null ? "Bank account added" : "Bank account updated");
      setBankForm(EMPTY_BANK);
      setBankFormOpen(false);
      setEditingBank(null);
    } else {
      toast.error(res.error ?? "Failed to save bank account");
    }
  }

  async function removeBankAccount(index: number) {
    if (!player) return;
    const b = (player.bank_accounts ?? [])[index];
    if (!b) return;
    if (!confirm(`Remove ${b.bank_name} account ${b.account_number}? Auto-matching deposits from it will stop.`)) return;
    const res = await updatePlayer(player.player_id, {
      bank_accounts: (player.bank_accounts ?? []).filter((_, i) => i !== index),
    });
    if (res.ok) toast.success("Bank account removed");
    else toast.error(res.error ?? "Failed to remove bank account");
  }

  async function saveGameAccount() {
    if (!player || !gameFormValid || savingGame) return;
    setSavingGame(true);
    const entry = {
      game_name: gameForm.game_name,
      game_username: gameForm.game_username.trim(),
    };
    const list = player.game_accounts ?? [];
    const res = await updatePlayer(player.player_id, {
      game_accounts:
        editingGame === null
          ? [...list, entry]
          : list.map((g, i) => (i === editingGame ? entry : g)),
    });
    setSavingGame(false);
    if (res.ok) {
      setGameAuditVersion((v) => v + 1);
      toast.success(editingGame === null ? "Game account linked" : "Game account updated");
      setGameForm(EMPTY_GAME);
      setGameFormOpen(false);
      setEditingGame(null);
    } else {
      toast.error(res.error ?? "Failed to save game account");
    }
  }

  async function removeGameAccount(index: number) {
    if (!player) return;
    const g = (player.game_accounts ?? [])[index];
    if (!g) return;
    if (!confirm(`Remove ${g.game_name} account "${g.game_username}"?`)) return;
    const res = await updatePlayer(player.player_id, {
      game_accounts: (player.game_accounts ?? []).filter((_, i) => i !== index),
    });
    if (res.ok) {
      setGameAuditVersion((v) => v + 1);
      toast.success("Game account removed");
    } else toast.error(res.error ?? "Failed to remove game account");
  }

  async function saveNotes() {
    if (!player || savingNotes) return;
    setSavingNotes(true);
    const res = await updatePlayer(player.player_id, { notes: notesDraft });
    setSavingNotes(false);
    if (res.ok) {
      toast.success("Notes saved");
    } else {
      toast.error(res.error ?? "Failed to save notes");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] w-[95vw] max-w-[1100px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1100px]">
        {!player && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Player not found.
          </div>
        )}
        {player && (
          <>
            <DialogHeader className="flex-shrink-0 space-y-0 border-b p-5 pb-4">
            
                            <div className="flex items-start gap-4">
                              <Avatar className="h-14 w-14 ring-2 ring-primary/10">
                                <AvatarFallback className="text-base font-semibold">
                                  {initialsOf(player.full_name)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="flex-1 min-w-0">
                                <DialogTitle className="text-lg flex items-center gap-2">
                                  {player.full_name}
                                  <StatusBadge status={player.status} />
                                </DialogTitle>
                                <DialogDescription className="mt-0.5">
                                  @{player.username} · Player ID P-{player.player_id}
                                </DialogDescription>
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
                                  {entityName(player.company_entity_id)}
                                </div>
                              </div>
                            </div>

                            <div className="mt-4 grid grid-cols-3 gap-3">
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
                              <div className="rounded-lg border bg-muted/30 p-3">
                                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                                  Profit
                                </div>
                                <div
                                  className={cn(
                                    "text-lg font-semibold mt-0.5",
                                    playerProfit >= 0 ? "text-emerald-600" : "text-rose-600",
                                  )}
                                >
                                  {formatRM(playerProfit)}
                                </div>
                              </div>
                            </div>
            
            </DialogHeader>

            <div className="flex flex-1 overflow-hidden">
              {/* Section nav. The profile has grown past what one scroll can
                  hold — transactions alone page through hundreds of rows. */}
              <nav className="w-44 flex-shrink-0 space-y-0.5 overflow-y-auto border-r bg-muted/30 p-2">
                {SECTIONS.map((s) => {
                  const Icon = s.icon;
                  // Viewers can't edit notes, so the tab is only worth showing
                  // when there is something written to read.
                  if (s.id === "notes" && isViewer && !player.notes) return null;
                  const active = section === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => setSection(s.id)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                        active
                          ? "bg-primary font-medium text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{s.label}</span>
                    </button>
                  );
                })}
              </nav>

              <div className="flex-1 overflow-y-auto p-5">
                {section === "profile" && (
                  <div className="space-y-6">
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
                    <Separator />
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
                  </div>
                )}

                {section === "balances" && (
                                <section>
                                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                                    Current Game Balances
                                  </h3>
                                  <div className="grid grid-cols-2 gap-2">
                                    {gameNames.map((g) => {
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
                )}

                {section === "transactions" && (
                  <PlayerTransactionsTab playerId={player.player_id} />
                )}

                {section === "banks" && (
                                <section>
                                  <div className="mb-2 flex items-center justify-between">
                                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                                      <Landmark className="h-3 w-3" />
                                      Bank Accounts on File
                                      {player.bank_accounts && player.bank_accounts.length > 0 && (
                                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground normal-case tracking-normal">
                                          {player.bank_accounts.length}
                                        </span>
                                      )}
                                    </h3>
                                    {!isViewer && !bankFormOpen && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => {
                                          setBankForm(EMPTY_BANK);
                                          setEditingBank(null);
                                          setBankFormOpen(true);
                                        }}
                                        className="h-7 -my-1 cursor-pointer"
                                      >
                                        <Plus className="h-3.5 w-3.5" />
                                        Add bank
                                      </Button>
                                    )}
                                  </div>
                                  {bankFormOpen && (
                                    <div className="mb-2 rounded-md border bg-muted/20 p-3 space-y-2">
                                      <div className="grid grid-cols-2 gap-2">
                                        <Select
                                          value={bankForm.bank_name || null}
                                          onValueChange={(v) =>
                                            setBankForm((f) => ({ ...f, bank_name: v ?? "" }))
                                          }
                                        >
                                          <SelectTrigger className="h-8 w-full cursor-pointer">
                                            <SelectValue placeholder="Select bank" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {banks.map((b) => (
                                              <SelectItem key={b} value={b} className="cursor-pointer">
                                                {b}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                        <Input
                                          value={bankForm.account_number}
                                          onChange={(e) =>
                                            setBankForm((f) => ({ ...f, account_number: e.target.value }))
                                          }
                                          placeholder="Account number"
                                          inputMode="numeric"
                                          className="h-8"
                                        />
                                      </div>
                                      <Input
                                        value={bankForm.account_holder}
                                        onChange={(e) =>
                                          setBankForm((f) => ({ ...f, account_holder: e.target.value }))
                                        }
                                        placeholder={`Holder name (defaults to ${player.full_name})`}
                                        className="h-8"
                                      />
                                      <div className="flex justify-end gap-2 pt-1">
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => {
                                            setBankFormOpen(false);
                                            setBankForm(EMPTY_BANK);
                                            setEditingBank(null);
                                          }}
                                          disabled={savingBank}
                                          className="cursor-pointer"
                                        >
                                          Cancel
                                        </Button>
                                        <Button
                                          size="sm"
                                          onClick={saveBankAccount}
                                          disabled={!bankFormValid || savingBank}
                                          className="cursor-pointer"
                                        >
                                          {savingBank ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                          ) : editingBank === null ? (
                                            <Plus className="h-3.5 w-3.5" />
                                          ) : (
                                            <Save className="h-3.5 w-3.5" />
                                          )}
                                          {editingBank === null ? "Add account" : "Save changes"}
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                  {player.bank_accounts && player.bank_accounts.length > 0 ? (
                                    <div className="space-y-2">
                                      {player.bank_accounts.map((b, i) => (
                                        <div
                                          key={i}
                                          className="group rounded-md border bg-card p-3 flex items-start gap-3"
                                        >
                                          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                                            <Landmark className="h-4 w-4" />
                                          </div>
                                          <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium">
                                              {b.account_holder}
                                            </div>
                                            <div className="text-[12px] font-mono text-muted-foreground mt-0.5">
                                              {b.account_number}
                                            </div>
                                          </div>
                                          <span className="inline-flex items-center rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] whitespace-nowrap">
                                            {b.bank_name}
                                          </span>
                                          {!isViewer && (
                                            <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                              <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => {
                                                  setBankForm({
                                                    bank_name: b.bank_name,
                                                    account_number: b.account_number,
                                                    account_holder: b.account_holder,
                                                  });
                                                  setEditingBank(i);
                                                  setBankFormOpen(true);
                                                }}
                                                className="h-6 w-6 cursor-pointer"
                                                aria-label={`Edit ${b.bank_name} account`}
                                              >
                                                <Pencil className="h-3 w-3" />
                                              </Button>
                                              <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => void removeBankAccount(i)}
                                                className="h-6 w-6 cursor-pointer text-rose-600 hover:text-rose-700"
                                                aria-label={`Remove ${b.bank_name} account`}
                                              >
                                                <Trash2 className="h-3 w-3" />
                                              </Button>
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-xs text-muted-foreground">
                                      No bank accounts on file. Auto-matching incoming deposits is disabled for this player.
                                    </p>
                                  )}
                                </section>
                )}

                {section === "games" && (
                                <section>
                                  <div className="mb-2 flex items-center justify-between">
                                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                                      <Gamepad2 className="h-3 w-3" />
                                      Linked Game Accounts
                                      {player.game_accounts && player.game_accounts.length > 0 && (
                                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground normal-case tracking-normal">
                                          {player.game_accounts.length}
                                        </span>
                                      )}
                                    </h3>
                                    {!isViewer && !gameFormOpen && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => {
                                          setGameForm(EMPTY_GAME);
                                          setEditingGame(null);
                                          setGameFormOpen(true);
                                        }}
                                        className="h-7 -my-1 cursor-pointer"
                                      >
                                        <Plus className="h-3.5 w-3.5" />
                                        Link game
                                      </Button>
                                    )}
                                  </div>
                                  {!isViewer && (
                                    <div className="mb-2">
                                      <AutoAssignGameButton playerId={player.player_id} />
                                    </div>
                                  )}
                                  {gameFormOpen && (
                                    <div className="mb-2 rounded-md border bg-muted/20 p-3 space-y-2">
                                      <div className="grid grid-cols-2 gap-2">
                                        <Select
                                          value={gameForm.game_name || null}
                                          onValueChange={(v) =>
                                            setGameForm((f) => ({ ...f, game_name: v ?? "" }))
                                          }
                                        >
                                          <SelectTrigger className="h-8 w-full cursor-pointer">
                                            <SelectValue placeholder="Select game" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {gamesFn().map((g) => (
                                              <SelectItem
                                                key={g}
                                                value={g}
                                                disabled={(player.game_accounts ?? []).some(
                                                  (ga, gi) => ga.game_name === g && gi !== editingGame,
                                                )}
                                                className="cursor-pointer"
                                              >
                                                {g}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                        <Input
                                          value={gameForm.game_username}
                                          onChange={(e) =>
                                            setGameForm((f) => ({ ...f, game_username: e.target.value }))
                                          }
                                          placeholder="Game username / ID"
                                          className="h-8"
                                        />
                                      </div>
                                      <div className="flex justify-end gap-2 pt-1">
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => {
                                            setGameFormOpen(false);
                                            setGameForm(EMPTY_GAME);
                                            setEditingGame(null);
                                          }}
                                          disabled={savingGame}
                                          className="cursor-pointer"
                                        >
                                          Cancel
                                        </Button>
                                        <Button
                                          size="sm"
                                          onClick={saveGameAccount}
                                          disabled={!gameFormValid || savingGame}
                                          className="cursor-pointer"
                                        >
                                          {savingGame ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                          ) : editingGame === null ? (
                                            <Plus className="h-3.5 w-3.5" />
                                          ) : (
                                            <Save className="h-3.5 w-3.5" />
                                          )}
                                          {editingGame === null ? "Link account" : "Save changes"}
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                  {player.game_accounts && player.game_accounts.length > 0 ? (
                                    <div className="grid grid-cols-2 gap-2">
                                      {player.game_accounts.map((g, i) => (
                                        <div
                                          key={i}
                                          className="group relative rounded-md border bg-card px-3 py-2"
                                        >
                                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                            {g.game_name}
                                          </div>
                                          <div className="text-sm font-medium font-mono mt-0.5 truncate">
                                            {g.game_username}
                                          </div>
                                          {!isViewer && (
                                            <div className="absolute top-1 right-1 flex gap-0.5 rounded-md bg-card opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                              <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => {
                                                  setGameForm({
                                                    game_name: g.game_name,
                                                    game_username: g.game_username,
                                                  });
                                                  setEditingGame(i);
                                                  setGameFormOpen(true);
                                                }}
                                                className="h-6 w-6 cursor-pointer"
                                                aria-label={`Edit ${g.game_name} account`}
                                              >
                                                <Pencil className="h-3 w-3" />
                                              </Button>
                                              <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => void removeGameAccount(i)}
                                                className="h-6 w-6 cursor-pointer text-rose-600 hover:text-rose-700"
                                                aria-label={`Remove ${g.game_name} account`}
                                              >
                                                <Trash2 className="h-3 w-3" />
                                              </Button>
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-xs text-muted-foreground">
                                      No game accounts linked. Top-ups will require manual game username entry.
                                    </p>
                                  )}

                                  <GameAccountHistory
                                    playerId={player.player_id}
                                    refreshKey={gameAuditVersion}
                                  />
                                </section>
                )}

                {section === "referrals" && (
                  <ReferralTab playerId={player.player_id} />
                )}

                {section === "recommend-bonus" && (
                  <ReferralBonusTab playerId={player.player_id} />
                )}

                {section === "notes" && (
                                    <section>
                                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                                        Internal Notes
                                      </h3>
                                      {isViewer ? (
                                        <div className="rounded-md border bg-muted/20 p-3 text-sm whitespace-pre-wrap">
                                          {player.notes}
                                        </div>
                                      ) : (
                                        <div className="space-y-2">
                                          <textarea
                                            value={notesDraft}
                                            onChange={(e) => setNotesDraft(e.target.value)}
                                            placeholder="VIP, prefers Mega888, etc."
                                            rows={3}
                                            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 resize-none"
                                          />
                                          <div className="flex justify-end">
                                            <Button
                                              size="sm"
                                              onClick={saveNotes}
                                              disabled={!notesDirty || savingNotes}
                                              className="cursor-pointer"
                                            >
                                              {savingNotes ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                              ) : (
                                                <Save className="h-3.5 w-3.5" />
                                              )}
                                              Save notes
                                            </Button>
                                          </div>
                                        </div>
                                      )}
                                    </section>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

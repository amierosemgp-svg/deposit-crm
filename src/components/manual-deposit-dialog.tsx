"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Loader2, Users } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PlayerPickerSheet } from "@/components/player-picker-sheet";
import { useStore } from "@/lib/store";
import type { Player } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ManualDepositDialog({ open, onOpenChange }: Props) {
  const players = useStore((s) => s.players);
  const banksFn = useStore((s) => s.banks);
  const bonusOptionsFn = useStore((s) => s.bonusOptions);
  const createDepositIntent = useStore((s) => s.createDepositIntent);
  const uploadFile = useStore((s) => s.uploadFile);
  const companyInScope = useStore((s) => s.companyInScope);
  // Subscribe to the scope selectors so eligiblePlayers re-computes if the
  // top-nav company/leader changes while the dialog is open.
  useStore((s) => s.selectedCompanyId);
  useStore((s) => s.selectedLeaderId);

  const banks = banksFn();
  const bonusOptions = bonusOptionsFn();

  const [player, setPlayer] = useState<Player | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [bank, setBank] = useState("");
  const [game, setGame] = useState("");
  const [bonus, setBonus] = useState("0");
  const [verified, setVerified] = useState(false);
  const [skipBot, setSkipBot] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset when the dialog closes (state-during-render).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setPlayer(null);
      setPickerOpen(false);
      setAmount("");
      setBank("");
      setGame("");
      setBonus("0");
      setVerified(false);
      setSkipBot(false);
      setFile(null);
      setSubmitting(false);
    }
  }

  const eligiblePlayers = players.filter((p) =>
    companyInScope(p.company_entity_id),
  );
  const playerGames = (player?.game_accounts ?? []).map((g) => g.game_name);

  const amt = Number.parseFloat(amount);
  const isValid =
    !!player && Number.isFinite(amt) && amt > 0 && bank !== "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || !player || submitting) return;
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
      player_id: player.player_id,
      amount: amt,
      bank_name: bank,
      status: verified || skipBot ? "pending" : "pending_match",
      selected_game: game || undefined,
      bonus_percentage: Number(bonus) || 0,
      receipt_url,
      skip_bot: skipBot,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error ?? "Failed to create deposit");
      return;
    }
    toast.success(
      skipBot
        ? "Manual deposit created — approve then complete it (agent skipped)"
        : verified
          ? "Manual deposit created — ready for approval"
          : "Manual deposit intent created — awaiting bank match",
    );
    onOpenChange(false);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0">
          <DialogTitle className="sr-only">Manual deposit</DialogTitle>

          <div className="flex items-center gap-3 border-b px-5 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Plus className="h-4.5 w-4.5" />
            </div>
            <div>
              <h2 className="text-base font-semibold leading-tight">
                Manual deposit
              </h2>
              <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
                Record a deposit reported by a player
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4 p-5">
            <div className="space-y-1.5">
              <Label>
                Player <span className="text-rose-600 dark:text-rose-400">*</span>
              </Label>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="flex h-9 w-full cursor-pointer items-center justify-between rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors hover:bg-muted/40 focus:border-ring focus:ring-2 focus:ring-ring/30"
              >
                {player ? (
                  <span className="truncate">
                    {player.full_name}{" "}
                    <span className="text-muted-foreground">
                      @{player.username}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Select player</span>
                )}
                <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="md-amount">
                  Amount (RM) <span className="text-rose-600 dark:text-rose-400">*</span>
                </Label>
                <Input
                  id="md-amount"
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
                  Bank <span className="text-rose-600 dark:text-rose-400">*</span>
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

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Game</Label>
                <Select value={game || null} onValueChange={(v) => setGame(v ?? "")}>
                  <SelectTrigger className="h-8 w-full cursor-pointer">
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent>
                    {playerGames.length === 0 ? (
                      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        {player
                          ? "No games linked to this player"
                          : "Select a player first"}
                      </div>
                    ) : (
                      playerGames.map((g) => (
                        <SelectItem key={g} value={g}>
                          {g}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Bonus %</Label>
                <Select
                  value={bonus}
                  onValueChange={(v) => setBonus(v ?? "0")}
                  items={bonusOptions.map((p) => ({
                    value: String(p),
                    label: `${p}%`,
                  }))}
                >
                  <SelectTrigger className="h-8 w-full cursor-pointer">
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
              </div>
            </div>

            <label
              className={`flex items-start gap-2.5 rounded-md border bg-muted/20 p-3 select-none ${
                skipBot ? "cursor-not-allowed opacity-50" : "cursor-pointer"
              }`}
            >
              <input
                type="checkbox"
                checked={verified || skipBot}
                disabled={skipBot}
                onChange={(e) => setVerified(e.target.checked)}
                className="mt-0.5 h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
              />
              <span>
                <span className="block text-sm font-medium">
                  Receipt already verified
                </span>
                <span className="block text-[11px] text-muted-foreground mt-0.5">
                  {verified || skipBot
                    ? "Created as Pending — ready to approve immediately."
                    : "Created as Awaiting Bank Match — the agent will confirm the bank transaction."}
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/40 p-3 select-none">
              <input
                type="checkbox"
                checked={skipBot}
                onChange={(e) => setSkipBot(e.target.checked)}
                className="mt-0.5 h-4 w-4 cursor-pointer accent-amber-600"
              />
              <span>
                <span className="block text-sm font-medium">
                  Handle manually (skip agent)
                </span>
                <span className="block text-[11px] text-muted-foreground mt-0.5">
                  {skipBot
                    ? "The agent won't match or top up this deposit — you'll Approve then Complete it yourself."
                    : "Leave off to let the agent verify the bank credit and do the game top-up."}
                </span>
              </span>
            </label>

            <div className="space-y-1.5">
              <Label htmlFor="md-receipt">Receipt (optional)</Label>
              <input
                id="md-receipt"
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
                disabled={submitting}
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

      <PlayerPickerSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        players={eligiblePlayers}
        title="Select player"
        description="Choose the player who made the deposit"
        onSelect={(p) => {
          setPlayer(p);
          setGame(""); // reset — game options depend on the player
        }}
      />
    </>
  );
}

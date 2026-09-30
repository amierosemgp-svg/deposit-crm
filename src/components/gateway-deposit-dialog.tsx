"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, CreditCard, ExternalLink, Loader2, Users } from "lucide-react";
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
import { BonusPicker } from "@/components/bonus-picker";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";
import {
  GATEWAY_METHOD_LABEL,
  type GatewayMethod,
  type GatewayPayment,
  type PaymentGateway,
  type Player,
} from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gateways: PaymentGateway[];
};

/**
 * Ask FlyPay to collect a deposit, and hand CS the link to send the player.
 *
 * Nothing here moves money. The deposit waits at "Awaiting Match" until FlyPay
 * calls back that the player paid; then it is approved and completed like any
 * other.
 */
export function GatewayDepositDialog({ open, onOpenChange, gateways }: Props) {
  const createGatewayDeposit = useStore((s) => s.createGatewayDeposit);

  const [player, setPlayer] = useState<Player | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<GatewayMethod>("DNQR");
  const [gatewayId, setGatewayId] = useState<number | null>(null);
  const [game, setGame] = useState("");
  const [bonusPlanId, setBonusPlanId] = useState<number | null>(null);
  const [bonusOverride, setBonusOverride] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [payment, setPayment] = useState<GatewayPayment | null>(null);
  const [copied, setCopied] = useState(false);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setPlayer(null);
      setPickerOpen(false);
      setAmount("");
      setMethod("DNQR");
      setGatewayId(null);
      setGame("");
      setBonusPlanId(null);
      setBonusOverride(undefined);
      setSubmitting(false);
      setPayment(null);
      setCopied(false);
    }
  }

  // Only the gateway of the player's own company can collect for them.
  const usable = player
    ? gateways.filter((g) => g.status === "active" && g.entity_id === player.company_entity_id)
    : [];
  const gateway =
    usable.find((g) => g.gateway_id === gatewayId) ?? (usable.length === 1 ? usable[0] : null);

  const playerGames = (player?.game_accounts ?? []).map((g) => g.game_name);
  const amt = Number.parseFloat(amount);
  const isValid = !!player && !!gateway && Number.isFinite(amt) && amt > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || !player || !gateway || submitting) return;
    setSubmitting(true);
    const res = await createGatewayDeposit(gateway.gateway_id, {
      player_id: player.player_id,
      amount: amt,
      payment_method: method,
      selected_game: game || undefined,
      bonus_plan_id: bonusPlanId,
      bonus_override_reason: bonusOverride,
    });
    setSubmitting(false);
    if (!res.ok || !res.payment) {
      toast.error(res.error ?? "FlyPay didn't open the payment");
      return;
    }
    setPayment(res.payment);
  }

  async function copyLink() {
    if (!payment?.cashier_url) return;
    try {
      await navigator.clipboard.writeText(payment.cashier_url);
      setCopied(true);
      toast.success("Payment link copied");
    } catch {
      toast.error("Couldn't copy — select the link and copy it by hand");
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0">
          <DialogTitle className="sr-only">FlyPay deposit</DialogTitle>

          <div className="flex items-center gap-3 border-b px-5 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
              <CreditCard className="h-4.5 w-4.5" />
            </div>
            <div>
              <h2 className="text-base font-semibold leading-tight">FlyPay deposit</h2>
              <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
                Make a payment link for the player to pay through FlyPay
              </p>
            </div>
          </div>

          {payment ? (
            <div className="space-y-4 p-5">
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-sm font-medium">
                  {formatRM(payment.amount)} · {GATEWAY_METHOD_LABEL[payment.payment_method as GatewayMethod] ?? payment.payment_method}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {payment.merchant_txn_id}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gd-link">Send this link to the player</Label>
                <div className="flex gap-2">
                  <Input
                    id="gd-link"
                    readOnly
                    value={payment.cashier_url ?? ""}
                    onFocus={(e) => e.currentTarget.select()}
                    className="h-8 font-mono text-[11px]"
                  />
                  <Button type="button" size="sm" onClick={copyLink} className="cursor-pointer">
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    Copy
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  The deposit waits under Awaiting Match. It moves to Matched by itself once
                  FlyPay confirms the payment.
                </p>
              </div>
              <div className="flex items-center justify-end gap-2 border-t pt-4">
                {payment.cashier_url && (
                  <a
                    href={payment.cashier_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open
                  </a>
                )}
                <Button type="button" onClick={() => onOpenChange(false)} className="cursor-pointer">
                  Done
                </Button>
              </div>
            </div>
          ) : (
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
                      <span className="text-muted-foreground">@{player.username}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Select player</span>
                  )}
                  <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
                {player && usable.length === 0 && (
                  <p className="text-[11px] text-rose-600 dark:text-rose-400">
                    This player&apos;s company has no FlyPay account set up.
                  </p>
                )}
              </div>

              {usable.length > 1 && (
                <div className="space-y-1.5">
                  <Label>FlyPay account</Label>
                  <Select
                    value={gateway ? String(gateway.gateway_id) : null}
                    onValueChange={(v) => setGatewayId(v ? Number(v) : null)}
                  >
                    <SelectTrigger className="h-8 w-full cursor-pointer">
                      <SelectValue placeholder="Select account" />
                    </SelectTrigger>
                    <SelectContent>
                      {usable.map((g) => (
                        <SelectItem key={g.gateway_id} value={String(g.gateway_id)}>
                          {g.account_label} · {g.merchant_code}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="gd-amount">
                    Amount (RM) <span className="text-rose-600 dark:text-rose-400">*</span>
                  </Label>
                  <Input
                    id="gd-amount"
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
                  <Label>Pay by</Label>
                  <Select
                    value={method}
                    onValueChange={(v) => setMethod((v as GatewayMethod) ?? "DNQR")}
                  >
                    <SelectTrigger className="h-8 w-full cursor-pointer">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(GATEWAY_METHOD_LABEL) as GatewayMethod[]).map((m) => (
                        <SelectItem key={m} value={m}>
                          {GATEWAY_METHOD_LABEL[m]}
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
                          {player ? "No games linked to this player" : "Select a player first"}
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
                  <Label>Bonus</Label>
                  <BonusPicker
                    playerId={player?.player_id ?? null}
                    depositAmount={Number.isFinite(amt) ? amt : 0}
                    planId={bonusPlanId}
                    percentage={0}
                    overrideReason={bonusOverride}
                    align="end"
                    className="h-8"
                    onPick={(choice) => {
                      setBonusPlanId(choice.bonus_plan_id);
                      setBonusOverride(choice.bonus_override_reason);
                    }}
                  />
                </div>
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
                <Button type="submit" disabled={!isValid || submitting} className="cursor-pointer">
                  {submitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CreditCard className="h-3.5 w-3.5" />
                  )}
                  Create payment link
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <PlayerPickerSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="Select player"
        description="Choose the player who will pay"
        onSelect={(p) => {
          setPlayer(p);
          setGame("");
          setGatewayId(null);
        }}
      />
    </>
  );
}

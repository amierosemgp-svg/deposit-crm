"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, CreditCard, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStore } from "@/lib/store";
import type { BankAccount, PaymentGateway } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: BankAccount | null;
  /** The gateway already on this account, if any. */
  gateway: PaymentGateway | null;
  onSaved: (gateway: PaymentGateway) => void;
};

const textareaClass =
  "block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/30";

/**
 * Connect a bank account to its FlyPay merchant.
 *
 * FlyPay issues the merchant code, the AES key and its own public key; the CRM
 * makes our key pair and shows the public half, which goes back to FlyPay's
 * tech team. Until they've uploaded it, every call is refused.
 */
export function PaymentGatewayModal({ open, onOpenChange, account, gateway, onSaved }: Props) {
  const savePaymentGateway = useStore((s) => s.savePaymentGateway);

  const [merchantCode, setMerchantCode] = useState("");
  const [aesKey, setAesKey] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [regenerate, setRegenerate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setMerchantCode(gateway?.merchant_code ?? "");
      setAesKey("");
      setProviderKey("");
      setRegenerate(false);
      setCopied(false);
    }
  }

  const isNew = !gateway;
  const isValid =
    merchantCode.trim() !== "" && (!isNew || (aesKey.trim() !== "" && providerKey.trim() !== ""));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!account || !isValid || saving) return;
    setSaving(true);
    const res = await savePaymentGateway({
      account_id: account.account_id,
      merchant_code: merchantCode.trim(),
      aes_key: aesKey.trim() || undefined,
      provider_public_key: providerKey.trim() || undefined,
      regenerate_keys: regenerate || undefined,
    });
    setSaving(false);
    if (!res.ok || !res.gateway) {
      toast.error(res.error ?? "Couldn't save the FlyPay settings");
      return;
    }
    toast.success(isNew ? "Connected to FlyPay" : "FlyPay settings saved");
    setAesKey("");
    setProviderKey("");
    setRegenerate(false);
    onSaved(res.gateway);
  }

  async function copyKey() {
    if (!gateway) return;
    try {
      await navigator.clipboard.writeText(gateway.merchant_public_key);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy — select the key and copy it by hand");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">FlyPay</DialogTitle>
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <CreditCard className="h-4.5 w-4.5" />
          </div>
          <div>
            <h2 className="text-base font-semibold leading-tight">FlyPay</h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              {account ? `${account.bank_name} · ${account.label ?? account.account_number}` : ""}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <div className="space-y-1.5">
            <Label htmlFor="pg-merchant">Merchant code</Label>
            <Input
              id="pg-merchant"
              value={merchantCode}
              onChange={(e) => setMerchantCode(e.target.value)}
              placeholder="From FlyPay, e.g. MYR00001"
              className="h-8"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pg-aes">AES key</Label>
            <Input
              id="pg-aes"
              type="password"
              autoComplete="off"
              value={aesKey}
              onChange={(e) => setAesKey(e.target.value)}
              placeholder={isNew ? "From FlyPay" : "Saved — leave blank to keep it"}
              className="h-8 font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pg-provider">FlyPay public key</Label>
            <textarea
              id="pg-provider"
              rows={3}
              value={providerKey}
              onChange={(e) => setProviderKey(e.target.value)}
              placeholder={isNew ? "Paste the key FlyPay sent" : "Saved — leave blank to keep it"}
              className={textareaClass}
            />
          </div>

          {gateway && (
            <div className="space-y-1.5 rounded-md border bg-muted/20 p-3">
              <div className="flex items-center justify-between">
                <Label>Our public key — send this to FlyPay&apos;s tech team</Label>
                <Button type="button" size="xs" variant="outline" onClick={copyKey} className="cursor-pointer">
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  Copy
                </Button>
              </div>
              <textarea readOnly rows={3} value={gateway.merchant_public_key} className={textareaClass} />
              <label className="flex cursor-pointer items-start gap-2 pt-1 text-[11px] text-muted-foreground select-none">
                <input
                  type="checkbox"
                  checked={regenerate}
                  onChange={(e) => setRegenerate(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-primary"
                />
                Issue a new key pair. FlyPay refuses every call until they have the new
                public key, so only do this if the old one leaked.
              </label>
            </div>
          )}
          {isNew && (
            <p className="text-[11px] text-muted-foreground">
              Saving makes our key pair. The public half appears here afterwards for you
              to send to FlyPay.
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="cursor-pointer"
            >
              Close
            </Button>
            <Button type="submit" disabled={!isValid || saving} className="cursor-pointer">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isNew ? "Connect" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

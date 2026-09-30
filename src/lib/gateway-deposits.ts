import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, deposits, gatewayPayments, paymentGateways, transactions } from "@/db/schema";
import { bonusOn } from "@/lib/bonus-math";
import { DEPOSIT_FAILED, DEPOSIT_SUCCESS, type FlyPayCredentials } from "@/lib/flypay";

type Payment = typeof gatewayPayments.$inferSelect;
type Gateway = typeof paymentGateways.$inferSelect;

export function credentialsOf(g: Gateway): FlyPayCredentials {
  return {
    merchant_code: g.merchant_code,
    currency: g.currency,
    aes_key: g.aes_key,
    merchant_private_key: g.merchant_private_key,
    provider_public_key: g.provider_public_key,
  };
}

/** A gateway as the browser may see it: never the AES key or our private key. */
export function publicGateway(
  g: Gateway,
  account: Pick<typeof bankAccounts.$inferSelect, "entity_id" | "bank_name" | "account_number" | "label">,
) {
  return {
    gateway_id: g.gateway_id,
    account_id: g.account_id,
    entity_id: account.entity_id,
    bank_name: account.bank_name,
    account_label: account.label ?? account.account_number,
    provider: g.provider,
    merchant_code: g.merchant_code,
    currency: g.currency,
    merchant_public_key: g.merchant_public_key,
    status: g.status,
    updated_at: g.updated_at,
  };
}

export function publicPayment(p: Payment) {
  return {
    payment_id: p.payment_id,
    deposit_id: p.deposit_id,
    merchant_txn_id: p.merchant_txn_id,
    provider_txn_id: p.provider_txn_id,
    payment_method: p.payment_method,
    amount: p.amount,
    net_amount: p.net_amount,
    status: p.status,
    cashier_url: p.cashier_url,
    error: p.error,
    updated_at: p.updated_at,
  };
}

/**
 * Put what the gateway said about a payment onto its deposit.
 *
 * Paid → the deposit is "matched": the money is confirmed, exactly what the
 * agent's bank match means for a bank deposit, and CS approves and completes it
 * from there as with any other. Failed → the deposit fails. Still in flight →
 * the deposit is left alone.
 *
 * Idempotent, because FlyPay retries a callback until it hears "success", and a
 * requery can race one: a deposit already past the step is not moved again.
 * A payment that lands after CS cancelled the link is reopened — the money
 * arrived, and a failed row would hide it.
 */
export async function applyGatewayResult(input: {
  merchantTxnId: string;
  statusId: number;
  amount?: number | null;
  netAmount?: number | null;
  providerTxnId?: string | null;
  raw: Record<string, unknown>;
  via: "callback" | "requery";
  userId?: number | null;
}) {
  const nowIso = new Date().toISOString();
  const outcome =
    input.statusId === DEPOSIT_SUCCESS
      ? "success"
      : input.statusId === DEPOSIT_FAILED
        ? "failed"
        : "submitted";

  return db.transaction(async (txn) => {
    const [payment] = await txn
      .select()
      .from(gatewayPayments)
      .where(eq(gatewayPayments.merchant_txn_id, input.merchantTxnId))
      .for("update");
    if (!payment) return null;

    const [deposit] = await txn
      .select()
      .from(deposits)
      .where(eq(deposits.deposit_id, payment.deposit_id))
      .for("update");

    const [updatedPayment] = await txn
      .update(gatewayPayments)
      .set({
        status: outcome,
        provider_status_id: input.statusId,
        provider_txn_id: input.providerTxnId ?? payment.provider_txn_id,
        net_amount: input.netAmount ?? payment.net_amount,
        last_response: input.raw,
        error: null,
        updated_at: nowIso,
      })
      .where(eq(gatewayPayments.payment_id, payment.payment_id))
      .returning();

    const ledger = {
      gateway: "flypay",
      via: input.via,
      merchant_txn_id: payment.merchant_txn_id,
      provider_txn_id: updatedPayment.provider_txn_id,
      from: deposit.status,
    };

    // Reopen a failed deposit only on the *first* word that it was paid. Once
    // the payment is on record as a success, a failed deposit is one CS
    // rejected after the money came, and FlyPay's retries must not undo that.
    const firstPaid = payment.status !== "success";
    if (
      outcome === "success" &&
      (deposit.status === "pending_match" || (deposit.status === "failed" && firstPaid))
    ) {
      // The amount FlyPay collected is the deposit. It can differ from what
      // was asked by a few cents when the gateway makes the amount unique.
      const paid = input.amount ?? deposit.deposit_amount;
      const amountChanged = Math.abs(paid - deposit.deposit_amount) >= 0.005;
      const bonus =
        amountChanged && deposit.bonus_basis_amount === null
          ? bonusOn(paid, deposit.bonus_percentage)
          : deposit.bonus_amount;

      const [updated] = await txn
        .update(deposits)
        .set({
          status: "matched",
          matched_at: nowIso,
          // When the money landed, not when the link was made.
          deposit_date: nowIso,
          deposit_time_known: true,
          ...(amountChanged
            ? {
                deposit_amount: paid,
                bonus_amount: bonus,
                total_amount: +(paid + bonus).toFixed(2),
              }
            : {}),
          updated_at: nowIso,
        })
        .where(eq(deposits.deposit_id, deposit.deposit_id))
        .returning();

      await txn.insert(transactions).values({
        player_id: deposit.player_id,
        entity_id: deposit.company_entity_id,
        type: "deposit",
        amount: paid,
        game_name: deposit.selected_game,
        reference_id: deposit.deposit_id,
        user_id: input.userId ?? null,
        details: {
          action: "gateway_paid",
          ...ledger,
          net_amount: updatedPayment.net_amount,
          ...(amountChanged ? { asked: deposit.deposit_amount, paid } : {}),
          ...(deposit.status === "failed" ? { reopened: true } : {}),
        },
      });
      return { deposit: updated, payment: updatedPayment };
    }

    if (outcome === "failed" && deposit.status === "pending_match") {
      const [updated] = await txn
        .update(deposits)
        .set({ status: "failed", updated_at: nowIso })
        .where(eq(deposits.deposit_id, deposit.deposit_id))
        .returning();

      await txn.insert(transactions).values({
        player_id: deposit.player_id,
        entity_id: deposit.company_entity_id,
        type: "deposit",
        amount: deposit.deposit_amount,
        game_name: deposit.selected_game,
        reference_id: deposit.deposit_id,
        user_id: input.userId ?? null,
        details: { action: "gateway_failed", ...ledger, remark: input.raw.Remark ?? null },
      });
      return { deposit: updated, payment: updatedPayment };
    }

    if (outcome === "failed" && deposit.status !== "failed") {
      // Paid once, failed now: a reversal on FlyPay's side. The deposit may
      // already be credited, so it is not moved automatically — this line is
      // what someone reconciling will find.
      console.warn(
        `FlyPay reports ${payment.merchant_txn_id} failed, but deposit ${deposit.deposit_id} is "${deposit.status}"`,
      );
    }
    return { deposit, payment: updatedPayment };
  });
}

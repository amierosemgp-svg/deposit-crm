import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deposits, gatewayPayments, paymentGateways, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser, requireWriteUser, type AuthedUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { FlyPayError, getDepositDetail } from "@/lib/flypay";
import { applyGatewayResult, credentialsOf, publicPayment } from "@/lib/gateway-deposits";

async function loadScoped(user: AuthedUser, depositId: number) {
  const [row] = await db
    .select({ d: deposits, p: gatewayPayments, g: paymentGateways })
    .from(gatewayPayments)
    .innerJoin(deposits, eq(deposits.deposit_id, gatewayPayments.deposit_id))
    .innerJoin(paymentGateways, eq(paymentGateways.gateway_id, gatewayPayments.gateway_id))
    .where(eq(gatewayPayments.deposit_id, depositId));
  if (!row) throw new AuthError(404, "This deposit wasn't collected through a gateway");
  if (
    user.companyIds !== null &&
    row.d.company_entity_id !== null &&
    !user.companyIds.includes(row.d.company_entity_id)
  ) {
    throw new AuthError(403, "Deposit is outside your company scope");
  }
  return row;
}

/** GET /api/deposits/:id/gateway — the payment behind a gateway deposit (its link, mostly). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const { p } = await loadScoped(user, Number(id));
    return Response.json({ payment: publicPayment(p) });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/**
 * POST /api/deposits/:id/gateway — ask FlyPay where this payment stands now.
 *
 * The callback is the normal path; this is for when it hasn't come — FlyPay
 * down, our deploy mid-flight, a player who says they paid. The answer is
 * applied exactly as a callback would be.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const { d, p, g } = await loadScoped(user, Number(id));

    try {
      const detail = await getDepositDetail(credentialsOf(g), p.merchant_txn_id);
      const applied = await applyGatewayResult({
        merchantTxnId: p.merchant_txn_id,
        statusId: detail.statusId,
        amount: detail.amount,
        netAmount: detail.netAmount ?? null,
        providerTxnId: detail.transactionId ?? null,
        raw: detail as unknown as Record<string, unknown>,
        via: "requery",
        userId: user.user_id,
      });
      return Response.json({
        status: detail.status,
        deposit: applied?.deposit ?? d,
        payment: applied ? publicPayment(applied.payment) : publicPayment(p),
      });
    } catch (e) {
      if (!(e instanceof FlyPayError)) throw e;
      // FlyPay has never heard of it: the submit never landed. Nothing will
      // ever be paid against it, so a waiting deposit is closed off.
      if (e.notFound && d.status === "pending_match") {
        const nowIso = new Date().toISOString();
        const deposit = await db.transaction(async (txn) => {
          await txn
            .update(gatewayPayments)
            .set({ status: "error", error: e.message, updated_at: nowIso })
            .where(eq(gatewayPayments.payment_id, p.payment_id));
          const [updated] = await txn
            .update(deposits)
            .set({ status: "failed", updated_at: nowIso })
            .where(eq(deposits.deposit_id, d.deposit_id))
            .returning();
          await txn.insert(transactions).values({
            player_id: d.player_id,
            entity_id: d.company_entity_id,
            type: "deposit",
            amount: d.deposit_amount,
            reference_id: d.deposit_id,
            user_id: user.user_id,
            details: {
              action: "gateway_not_found",
              gateway: "flypay",
              merchant_txn_id: p.merchant_txn_id,
              error: e.message,
            },
          });
          return updated;
        });
        return Response.json({ status: "Not found at FlyPay", deposit });
      }
      return jsonError(e.message, 502);
    }
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

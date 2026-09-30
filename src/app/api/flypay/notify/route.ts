import { eq } from "drizzle-orm";
import { db } from "@/db";
import { gatewayPayments, paymentGateways } from "@/db/schema";
import { aesDecrypt, verifySha1 } from "@/lib/flypay";
import { applyGatewayResult } from "@/lib/gateway-deposits";

/**
 * POST /api/flypay/notify — FlyPay's deposit callback (guide section 1.2).
 *
 * Public: there is no session and no API key. What makes it trustworthy is the
 * signature — the decrypted body must verify against FlyPay's public key for
 * the merchant that payment belongs to, so a forged call can't mark anything
 * paid without FlyPay's private key.
 *
 * FlyPay keeps calling until the body is exactly "success". Anything we can't
 * verify gets a non-200 so it keeps trying; anything already applied gets
 * "success" again, because applyGatewayResult is idempotent.
 */

/** FlyPay's samples mix PascalCase and camelCase; take either. */
function pick(body: Record<string, unknown>, key: string): unknown {
  const lower = key.toLowerCase();
  const found = Object.keys(body).find((k) => k.toLowerCase() === lower);
  return found ? body[found] : undefined;
}

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain" } });

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return text("bad request", 400);

  const merchantTxnId = String(pick(body, "MerchantTransactionId") ?? "");
  const data = String(pick(body, "Data") ?? "");
  const signature = String(pick(body, "Signature") ?? "");
  if (!merchantTxnId || !data || !signature) return text("bad request", 400);

  const [row] = await db
    .select({ gateway: paymentGateways })
    .from(gatewayPayments)
    .innerJoin(paymentGateways, eq(paymentGateways.gateway_id, gatewayPayments.gateway_id))
    .where(eq(gatewayPayments.merchant_txn_id, merchantTxnId));
  if (!row) {
    console.warn(`FlyPay callback for unknown payment ${merchantTxnId}`);
    return text("unknown transaction", 404);
  }
  const { gateway } = row;

  let plain: string;
  try {
    plain = aesDecrypt(data, gateway.aes_key);
  } catch {
    console.warn(`FlyPay callback for ${merchantTxnId}: Data does not decrypt`);
    return text("bad data", 400);
  }
  if (!verifySha1(plain, signature, gateway.provider_public_key)) {
    console.warn(`FlyPay callback for ${merchantTxnId}: signature does not verify`);
    return text("bad signature", 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(plain) as Record<string, unknown>;
  } catch {
    return text("bad data", 400);
  }

  // The signed body has to be about the payment the envelope names, for the
  // merchant it was sent to — otherwise a genuine callback for one payment
  // could be replayed against another.
  if (
    String(pick(payload, "MerchantTransactionId") ?? "") !== merchantTxnId ||
    String(pick(payload, "MerchantCode") ?? "") !== gateway.merchant_code
  ) {
    console.warn(`FlyPay callback for ${merchantTxnId}: signed body names a different payment`);
    return text("mismatch", 400);
  }

  const statusId = num(pick(payload, "Status"));
  if (statusId === null) return text("bad data", 400);

  await applyGatewayResult({
    merchantTxnId,
    statusId,
    amount: num(pick(payload, "Amount")),
    netAmount: num(pick(payload, "NetAmount")),
    providerTxnId: (pick(body, "TransactionId") as string | undefined) ?? null,
    raw: payload,
    via: "callback",
  });

  return text("success");
}

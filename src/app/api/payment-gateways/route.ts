import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, paymentGateways } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { companyOfEntity, logActivity } from "@/lib/activity-log";
import { generateMerchantKeys, readPublicKey } from "@/lib/flypay";
import { publicGateway } from "@/lib/gateway-deposits";

/**
 * GET /api/payment-gateways — the gateways on accounts the caller can see.
 * CS need this too: it is how the deposit screen knows a company takes FlyPay.
 * Secrets never leave the server.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const rows = await db
      .select({ g: paymentGateways, a: bankAccounts })
      .from(paymentGateways)
      .innerJoin(bankAccounts, eq(bankAccounts.account_id, paymentGateways.account_id))
      .where(
        user.ownedEntityIds === null
          ? undefined
          : inArray(bankAccounts.entity_id, user.ownedEntityIds.length ? user.ownedEntityIds : [-1]),
      );
    return Response.json({ gateways: rows.map((r) => publicGateway(r.g, r.a)) });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

const setupSchema = z.object({
  account_id: z.number().int().positive(),
  merchant_code: z.string().trim().min(1).max(60),
  currency: z.string().trim().length(3).optional(),
  // Required the first time; left out on an edit, the stored one stays.
  aes_key: z.string().trim().min(1).optional(),
  provider_public_key: z.string().trim().min(1).optional(),
  // Issue a new merchant key pair. The new public key must then go to FlyPay,
  // and until it does every call is refused — so this is never implied.
  regenerate_keys: z.boolean().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

/**
 * POST /api/payment-gateways — connect a bank account to its FlyPay merchant.
 *
 * The merchant key pair is generated here, on first setup, so the private half
 * never passes through anyone's clipboard. The response carries the public
 * half, which is what FlyPay's tech team asks for.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (user.role === "cs_agent") {
      throw new AuthError(403, "Only leaders and admins set up payment gateways");
    }
    const parsed = setupSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    const body = parsed.data;

    const [account] = await db
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.account_id, body.account_id));
    if (!account) return jsonError("Bank account not found", 404);
    if (user.ownedEntityIds !== null && !user.ownedEntityIds.includes(account.entity_id)) {
      throw new AuthError(403, "Account is outside your scope");
    }

    if (body.provider_public_key) {
      try {
        readPublicKey(body.provider_public_key);
      } catch {
        return jsonError("That doesn't read as an RSA public key — paste FlyPay's key exactly as sent");
      }
    }

    const [existing] = await db
      .select()
      .from(paymentGateways)
      .where(eq(paymentGateways.account_id, account.account_id));
    const nowIso = new Date().toISOString();

    let saved: typeof paymentGateways.$inferSelect;
    if (!existing) {
      if (!body.aes_key || !body.provider_public_key) {
        return jsonError("The AES key and FlyPay's public key are both needed to set it up");
      }
      const keys = generateMerchantKeys();
      [saved] = await db
        .insert(paymentGateways)
        .values({
          account_id: account.account_id,
          merchant_code: body.merchant_code,
          currency: body.currency?.toUpperCase() ?? "MYR",
          aes_key: body.aes_key,
          provider_public_key: body.provider_public_key,
          merchant_private_key: keys.privateKey,
          merchant_public_key: keys.publicKey,
          status: body.status ?? "active",
        })
        .returning();
    } else {
      const keys = body.regenerate_keys ? generateMerchantKeys() : null;
      [saved] = await db
        .update(paymentGateways)
        .set({
          merchant_code: body.merchant_code,
          ...(body.currency ? { currency: body.currency.toUpperCase() } : {}),
          ...(body.aes_key ? { aes_key: body.aes_key } : {}),
          ...(body.provider_public_key ? { provider_public_key: body.provider_public_key } : {}),
          ...(keys
            ? { merchant_private_key: keys.privateKey, merchant_public_key: keys.publicKey }
            : {}),
          ...(body.status ? { status: body.status } : {}),
          updated_at: nowIso,
        })
        .where(eq(paymentGateways.gateway_id, existing.gateway_id))
        .returning();
    }

    const label = `${account.bank_name} ••••${account.account_number.slice(-4)}`;
    await logActivity({
      category: "bank_account",
      action: existing ? "payment_gateway.updated" : "payment_gateway.connected",
      summary: `${label} ${existing ? "gateway settings changed" : "connected to FlyPay"} — merchant ${saved.merchant_code}${
        body.regenerate_keys ? ", new merchant keys issued" : ""
      }${body.aes_key && existing ? ", AES key replaced" : ""}${
        body.provider_public_key && existing ? ", FlyPay key replaced" : ""
      }`,
      actor: user,
      companyEntityId: await companyOfEntity(account.entity_id),
      targetType: "bank_account",
      targetId: account.account_id,
      targetLabel: label,
    });

    return Response.json({ gateway: publicGateway(saved, account) }, { status: existing ? 200 : 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

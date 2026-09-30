import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, deposits, gatewayPayments, paymentGateways, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { assertNotArchived, jsonError } from "@/lib/api-helpers";
import { canOverrideEligibility, resolveBonusForDeposit } from "@/lib/bonus";
import { FlyPayError, newMerchantTxnId, submitDeposit } from "@/lib/flypay";
import { credentialsOf, publicPayment } from "@/lib/gateway-deposits";

const createSchema = z.object({
  player_id: z.number().int().positive(),
  amount: z.number().positive(),
  payment_method: z.enum(["DNQR", "OB", "TNG"]),
  selected_game: z.string().optional(),
  selected_game_username: z.string().max(120).optional(),
  bonus_plan_id: z.number().int().positive().nullable().optional(),
  bonus_percentage: z.number().min(0).max(200).optional(),
  bonus_override_reason: z.string().max(200).optional(),
});

/**
 * Where FlyPay should call back and send the player afterwards. The request's
 * own origin is right on Vercel; APP_URL overrides it behind anything else.
 */
function publicOrigin(request: Request): string {
  return (process.env.APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
}

/**
 * POST /api/payment-gateways/:id/deposits — ask FlyPay to collect a deposit.
 *
 * The deposit is written first, at "pending_match" (waiting for the money),
 * and only then is FlyPay asked. That order means a callback can never arrive
 * for a deposit we haven't recorded, and a request that dies half-way still
 * leaves a row CS can check rather than a payment nobody knows about.
 *
 * FlyPay's answer is a cashier link for CS to send the player. When the player
 * pays, FlyPay calls /api/flypay/notify and the deposit moves to "matched".
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    const body = parsed.data;

    const [row] = await db
      .select({ g: paymentGateways, a: bankAccounts })
      .from(paymentGateways)
      .innerJoin(bankAccounts, eq(bankAccounts.account_id, paymentGateways.account_id))
      .where(eq(paymentGateways.gateway_id, Number(id)));
    if (!row) return jsonError("Payment gateway not found", 404);
    const { g: gateway, a: account } = row;
    if (gateway.status !== "active" || account.status !== "active") {
      return jsonError("This payment gateway is switched off", 409);
    }

    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.player_id, body.player_id));
    if (!player) return jsonError("Player not found", 404);
    if (user.companyIds !== null && !user.companyIds.includes(player.company_entity_id)) {
      throw new AuthError(403, "Player is outside your company scope");
    }
    assertNotArchived(player);
    if (account.entity_id !== player.company_entity_id) {
      throw new AuthError(403, "That gateway belongs to another company");
    }

    const bonus = await resolveBonusForDeposit({
      planId: body.bonus_plan_id ?? null,
      fallbackPercentage: body.bonus_percentage,
      ctx: {
        playerId: player.player_id,
        companyEntityId: player.company_entity_id,
        depositAmount: body.amount,
      },
      override: {
        allowed: canOverrideEligibility(user.role) && !!body.bonus_override_reason,
        reason: body.bonus_override_reason,
      },
    });
    if (!bonus.ok) return jsonError(bonus.reason, bonus.status);

    const merchantTxnId = newMerchantTxnId();
    const nowIso = new Date().toISOString();

    const { deposit, payment } = await db.transaction(async (txn) => {
      const [created] = await txn
        .insert(deposits)
        .values({
          transaction_ref: merchantTxnId,
          deposit_date: nowIso,
          player_id: player.player_id,
          player_username: player.username,
          company_entity_id: player.company_entity_id,
          deposit_amount: body.amount,
          bank_name: account.bank_name,
          received_into_account_id: account.account_id,
          selected_game: body.selected_game,
          selected_game_username: body.selected_game_username,
          ...bonus.fields,
          status: "pending_match",
          source: "manual",
          // The gateway confirms the money; a person tops up the game.
          skip_bot: true,
          handled_by_user_id: user.user_id,
          // Whoever sent the link is the one who'll approve it.
          assigned_to_user_id: user.user_id,
          assigned_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .returning();

      const [pay] = await txn
        .insert(gatewayPayments)
        .values({
          gateway_id: gateway.gateway_id,
          deposit_id: created.deposit_id,
          merchant_txn_id: merchantTxnId,
          payment_method: body.payment_method,
          amount: body.amount,
        })
        .returning();

      await txn.insert(transactions).values({
        player_id: player.player_id,
        entity_id: player.company_entity_id,
        type: "deposit",
        amount: body.amount,
        reference_id: created.deposit_id,
        user_id: user.user_id,
        details: {
          source: "manual",
          action: "intent_created",
          status: "pending_match",
          gateway: "flypay",
          merchant_txn_id: merchantTxnId,
          payment_method: body.payment_method,
          ...(bonus.plan
            ? {
                bonus: bonus.plan.name,
                bonus_plan_id: bonus.plan.plan_id,
                bonus_amount: bonus.fields.bonus_amount,
                ...(bonus.fields.bonus_override_reason
                  ? { bonus_override_reason: bonus.fields.bonus_override_reason }
                  : {}),
              }
            : {}),
        },
      });
      return { deposit: created, payment: pay };
    });

    const origin = publicOrigin(request);
    try {
      const res = await submitDeposit(credentialsOf(gateway), {
        merchantTxnId,
        clientId: player.username,
        amount: body.amount,
        method: body.payment_method,
        notifyUrl: `${origin}/api/flypay/notify`,
        returnUrl: `${origin}/payment-done.html`,
        // FlyPay wants the paying client's IP. The player never touches the
        // CRM, so the nearest honest answer is the desk that asked.
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1",
        accountHolderName: player.full_name,
      });
      const [updated] = await db
        .update(gatewayPayments)
        .set({
          provider_txn_id: res.transactionId,
          cashier_url: res.url,
          last_response: res as unknown as Record<string, unknown>,
          updated_at: new Date().toISOString(),
        })
        .where(eq(gatewayPayments.payment_id, payment.payment_id))
        .returning();
      return Response.json({ deposit, payment: publicPayment(updated) }, { status: 201 });
    } catch (e) {
      if (!(e instanceof FlyPayError)) throw e;
      const failNow = e.answered;
      await db.transaction(async (txn) => {
        await txn
          .update(gatewayPayments)
          .set({ status: failNow ? "error" : "submitted", error: e.message, updated_at: new Date().toISOString() })
          .where(eq(gatewayPayments.payment_id, payment.payment_id));
        // A refusal is final — nothing was opened, so the deposit is failed on
        // the spot. No answer at all is not: FlyPay may have opened it, and the
        // Check button will find out.
        if (failNow) {
          await txn
            .update(deposits)
            .set({ status: "failed", updated_at: new Date().toISOString() })
            .where(eq(deposits.deposit_id, deposit.deposit_id));
          await txn.insert(transactions).values({
            player_id: player.player_id,
            entity_id: player.company_entity_id,
            type: "deposit",
            amount: body.amount,
            reference_id: deposit.deposit_id,
            user_id: user.user_id,
            details: {
              action: "gateway_refused",
              gateway: "flypay",
              merchant_txn_id: merchantTxnId,
              error: e.message,
            },
          });
        }
      });
      return jsonError(
        failNow
          ? e.message
          : `${e.message}. The deposit is saved — press Check on it to see whether FlyPay opened the payment.`,
        502,
      );
    }
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

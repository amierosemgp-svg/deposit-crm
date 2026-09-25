import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, claims, transactions, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { InsufficientBankBalanceError, moveBankBalance } from "@/lib/bank-balance";

const patchSchema = z.object({
  status: z.enum(["outstanding", "settled", "cancelled"]),
  /**
   * Which account paid the claimant back. Required to settle unless the money
   * went out some other way — cash, or another company's account — in which
   * case leave it out and no balance moves.
   */
  settled_from_account_id: z.number().int().positive().nullable().optional(),
});

/**
 * PATCH /api/claims/:id — settle a claim, or put it back.
 *
 * Settling records that the debt is cleared. It does not move money: the desk
 * enters the payment itself as its own Clear Bank row, which is where that
 * movement belongs and where the account gets debited.
 *
 * `settled_from_account_id` is the exception. Pass it and the money leaves that
 * account here, in the same transaction, and reopening credits it back — so the
 * pair always nets to nothing. Nothing in the UI passes it today, by decision
 * (Arius, 2026-09-25: "just leave it as pure recording"), and the path is kept
 * because a claim settled straight out of a named account should never be able to
 * mark itself paid while the balance sits untouched.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const isAdmin = user.role === "super_admin";
    const { id } = await params;
    const claimId = Number(id);

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    }
    const body = parsed.data;

    const [existing] = await db.select().from(claims).where(eq(claims.claim_id, claimId));
    if (!existing) return jsonError("Claim not found", 404);

    /**
     * CS settles these, not just admins.
     *
     * This was admin-only while settling looked like authorising a payment. It is
     * not: nothing here moves a bank balance, and the desk records the money going
     * out as its own Clear Bank row. Marking a claim settled is bookkeeping — it
     * says the debt is gone, and the row that proves it lives elsewhere. Holding
     * that behind an admin is how the debt ends up unrecorded, which is the
     * original problem.
     *
     * The guard that stays is whose claim it is. A user works for a set of
     * companies, and may only settle a claim booked against one of them — the same
     * scope POST applies when the claim is recorded.
     */
    if (!isAdmin && user.companyIds !== null && !user.companyIds.includes(existing.entity_id)) {
      throw new AuthError(403, "Settle a claim against one of your own companies");
    }
    if (existing.status === body.status) {
      return Response.json({ claim: existing });
    }

    if (body.settled_from_account_id != null) {
      const [account] = await db
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, body.settled_from_account_id));
      if (!account) return jsonError("Bank account not found", 404);
      if (user.ownedEntityIds !== null && !user.ownedEntityIds.includes(account.entity_id)) {
        throw new AuthError(403, "That bank account is outside your organisation");
      }
    }

    const updated = await db.transaction(async (txn) => {
      const settling = body.status === "settled";
      const account = settling
        ? (body.settled_from_account_id ?? null)
        : existing.settled_from_account_id;

      const [row] = await txn
        .update(claims)
        .set({
          status: body.status,
          settled_at: settling ? new Date().toISOString() : null,
          settled_by_user_id: settling ? user.user_id : null,
          settled_from_account_id: settling ? account : null,
        })
        .where(eq(claims.claim_id, claimId))
        .returning();

      // Paying it out debits; taking the settlement back credits the same
      // account by the same amount, so the pair always nets to nothing.
      if (account != null && (settling || existing.status === "settled")) {
        const delta = settling ? -row.amount : row.amount;
        const balance = await moveBankBalance(txn, { accountId: account, delta });
        const [acct] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, account));
        await txn.insert(transactions).values({
          entity_id: acct?.entity_id ?? row.entity_id,
          type: "expense",
          amount: row.amount,
          reference_id: row.claim_id,
          user_id: user.user_id,
          details: {
            action: settling ? "claim_settled" : "claim_reopened",
            reason: row.reason,
            account_id: account,
            bank: acct ? `${acct.bank_name} ${acct.account_number}` : null,
            balance_after: balance,
          },
        });
      }
      return row;
    });

    const [claimant] = await db
      .select()
      .from(users)
      .where(eq(users.user_id, updated.claimed_by_user_id));

    await logActivity({
      category: "expense",
      action: `claim.${body.status}`,
      summary: `Claim ${claimId} (${claimant?.username ?? "unknown"}, RM ${updated.amount.toFixed(2)}) marked ${body.status}`,
      actor: user,
      companyEntityId: updated.entity_id,
      targetType: "claim",
      targetId: updated.claim_id,
      targetLabel: updated.reason,
      context: { amount: updated.amount, status: body.status },
    });

    return Response.json({ claim: updated });
  } catch (e) {
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/**
 * DELETE /api/claims/:id — remove a claim entered by mistake.
 *
 * A settled claim has moved money, so it is reopened first (which credits the
 * account back) rather than deleted out from under its own transaction row.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const isAdmin = user.role === "super_admin";
    const { id } = await params;

    const [existing] = await db.select().from(claims).where(eq(claims.claim_id, Number(id)));
    if (!existing) return jsonError("Claim not found", 404);
    if (!isAdmin && existing.recorded_by_user_id !== user.user_id) {
      throw new AuthError(403, "Only the person who recorded it, or an admin, can remove it");
    }
    if (existing.status === "settled") {
      return jsonError("Reopen the claim before deleting it — settling it moved money", 422);
    }

    const [deleted] = await db.delete(claims).where(eq(claims.claim_id, Number(id))).returning();

    await logActivity({
      category: "expense",
      action: "claim.deleted",
      summary: `Claim removed: RM ${deleted.amount.toFixed(2)} — ${deleted.reason}`,
      actor: user,
      companyEntityId: deleted.entity_id,
      targetType: "claim",
      targetId: deleted.claim_id,
      targetLabel: deleted.reason,
    });

    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

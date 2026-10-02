import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, claims, entities, transactions, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { describeChanges, diffFields, logActivity } from "@/lib/activity-log";
import { InsufficientBankBalanceError, moveBankBalance } from "@/lib/bank-balance";

/**
 * Every typed-in cell of the claim sheet, plus its status — each optional, so
 * the worksheet can send just the cell that changed.
 */
const patchSchema = z.object({
  /** "Owed By" — the casino whose debt it is. */
  entity_id: z.number().int().positive().optional(),
  /** "Owed To" — who put the money in. */
  claimed_by_user_id: z.number().int().positive().optional(),
  amount: z.number().positive().optional(),
  occurred_at: z.string().min(1).optional(),
  reason: z.string().trim().min(1).max(200).optional(),
  notes: z.string().nullable().optional(),
  /** "Paid Into" — where the claimant's money landed. Recorded, never moved. */
  paid_into_account_id: z.number().int().positive().nullable().optional(),
  status: z.enum(["outstanding", "settled", "cancelled"]).optional(),
  /**
   * Which account paid the claimant back. Leave it out to settle without
   * moving a balance — cash, or another company's account — which is what the
   * sheet does today. On a claim that is already settled, sending it (or
   * null) changes which account the settlement came out of, re-booking both.
   */
  settled_from_account_id: z.number().int().positive().nullable().optional(),
});

/**
 * PATCH /api/claims/:id — correct a claim, settle it, or put it back.
 *
 * Any cell, by anyone who can write, in the claim's company. Who recorded it
 * does not matter: the person who spots that the casino or the figure is wrong
 * is usually the one settling it, not the one who typed it, and sending them to
 * find the recorder is how the wrong figure gets paid. The guard that stays is
 * whose claim it is — a user may only touch a claim booked against one of the
 * companies they work for, and may only move it to another of those.
 *
 * Settling records that the debt is cleared. It does not move money: the desk
 * enters the payment itself as its own Clear Bank row, which is where that
 * movement belongs and where the account gets debited. Nothing in the UI sends
 * `settled_from_account_id`, by decision (Arius, 2026-09-25: "just leave it as
 * pure recording").
 *
 * When it is sent, the money leaves that account here, and everything after
 * keeps the booking honest: reopening or cancelling credits it back, and
 * editing the amount of a claim settled out of an account re-books it. The
 * rule is the same one every corrected row follows — take the old booking off,
 * put the new one on, netted per account so only the difference touches a
 * balance, all in one transaction under a lock on the claim. A claim whose
 * settlement named no account moved nothing and re-books nothing; neither does
 * Paid Into, which POST deliberately never books.
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
    if (!Number.isInteger(claimId)) return jsonError("Bad claim id");

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    }
    const body = parsed.data;
    const inMyCompanies = (entityId: number) =>
      isAdmin || user.companyIds === null || user.companyIds.includes(entityId);

    const result = await db.transaction(async (txn) => {
      const [existing] = await txn
        .select()
        .from(claims)
        .where(eq(claims.claim_id, claimId))
        .for("update");
      if (!existing) throw new AuthError(404, "Claim not found");
      if (!inMyCompanies(existing.entity_id)) {
        throw new AuthError(403, "Edit a claim against one of your own companies");
      }

      // Whose debt it is: still a company, still one of yours — as POST.
      if (body.entity_id !== undefined && body.entity_id !== existing.entity_id) {
        const [company] = await txn
          .select()
          .from(entities)
          .where(eq(entities.entity_id, body.entity_id));
        if (!company) throw new AuthError(404, "Company not found");
        if (company.entity_type !== "company") {
          throw new AuthError(400, `Entity ${body.entity_id} is not a company`);
        }
        if (!inMyCompanies(body.entity_id)) {
          throw new AuthError(403, "Move the claim to one of your own companies");
        }
      }
      if (
        body.claimed_by_user_id !== undefined &&
        body.claimed_by_user_id !== existing.claimed_by_user_id
      ) {
        const [claimant] = await txn
          .select({ user_id: users.user_id })
          .from(users)
          .where(eq(users.user_id, body.claimed_by_user_id));
        if (!claimant) throw new AuthError(404, "Claimant not found");
      }

      // Any account named here has to be inside the caller's organisation.
      for (const accountId of [body.paid_into_account_id, body.settled_from_account_id]) {
        if (accountId == null) continue;
        const [account] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, accountId));
        if (!account) throw new AuthError(404, "Bank account not found");
        if (user.ownedEntityIds !== null && !user.ownedEntityIds.includes(account.entity_id)) {
          throw new AuthError(403, "That bank account is outside your organisation");
        }
      }

      const wasSettled = existing.status === "settled";
      const status = body.status ?? existing.status;
      const settled = status === "settled";
      const settling = settled && !wasSettled;
      const amount = body.amount ?? existing.amount;

      /**
       * Where the settlement came out of, after the edit. A fresh settlement
       * takes what was sent (nothing = no account); a claim staying settled
       * keeps its account unless one was sent; anything not settled has none.
       */
      const settledFrom = !settled
        ? null
        : settling || body.settled_from_account_id !== undefined
          ? (body.settled_from_account_id ?? null)
          : existing.settled_from_account_id;

      // Re-book: old settlement off, new one on, netted per account.
      const net = new Map<number, number>();
      if (wasSettled && existing.settled_from_account_id != null) {
        net.set(existing.settled_from_account_id, existing.amount);
      }
      if (settledFrom != null) {
        net.set(settledFrom, (net.get(settledFrom) ?? 0) - amount);
      }
      const moved: { account_id: number; delta: number; balance_after: number }[] = [];
      for (const [accountId, raw] of [...net.entries()].sort((a, b) => a[0] - b[0])) {
        const delta = +raw.toFixed(2);
        if (delta === 0) continue;
        moved.push({
          account_id: accountId,
          delta,
          balance_after: await moveBankBalance(txn, { accountId, delta }),
        });
      }

      const [row] = await txn
        .update(claims)
        .set({
          ...(body.entity_id !== undefined ? { entity_id: body.entity_id } : {}),
          ...(body.claimed_by_user_id !== undefined
            ? { claimed_by_user_id: body.claimed_by_user_id }
            : {}),
          amount,
          ...(body.occurred_at !== undefined ? { occurred_at: body.occurred_at } : {}),
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          ...(body.notes !== undefined ? { notes: body.notes?.trim() || null } : {}),
          ...(body.paid_into_account_id !== undefined
            ? { paid_into_account_id: body.paid_into_account_id }
            : {}),
          status,
          // Who settled it and when belong to the settling, not to a later
          // correction of a claim that stays settled.
          settled_at: settling
            ? new Date().toISOString()
            : settled
              ? existing.settled_at
              : null,
          settled_by_user_id: settling
            ? user.user_id
            : settled
              ? existing.settled_by_user_id
              : null,
          settled_from_account_id: settledFrom,
        })
        .where(eq(claims.claim_id, claimId))
        .returning();

      const action = settling
        ? "claim_settled"
        : wasSettled && !settled
          ? status === "cancelled"
            ? "claim_cancelled"
            : "claim_reopened"
          : "claim_rebooked";
      for (const m of moved) {
        const [acct] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, m.account_id));
        await txn.insert(transactions).values({
          entity_id: acct?.entity_id ?? row.entity_id,
          type: "expense",
          amount: Math.abs(m.delta),
          reference_id: row.claim_id,
          user_id: user.user_id,
          details: {
            action,
            reason: row.reason,
            account_id: m.account_id,
            bank: acct ? `${acct.bank_name} ${acct.account_number}` : null,
            delta: m.delta,
            balance_after: m.balance_after,
          },
        });
      }

      const shape = (c: typeof existing) => ({
        entity_id: c.entity_id,
        claimed_by_user_id: c.claimed_by_user_id,
        amount: c.amount,
        occurred_at: c.occurred_at,
        reason: c.reason,
        notes: c.notes,
        paid_into_account_id: c.paid_into_account_id,
        status: c.status,
        settled_from_account_id: c.settled_from_account_id,
      });
      return { existing, row, changes: diffFields(shape(existing), shape(row)), moved };
    });

    const { existing, row: updated, changes, moved } = result;
    if (changes.length) {
      const [claimant] = await db
        .select()
        .from(users)
        .where(eq(users.user_id, updated.claimed_by_user_id));
      const statusChanged = existing.status !== updated.status;
      await logActivity({
        category: "expense",
        action: statusChanged ? `claim.${updated.status}` : "claim.edited",
        summary:
          `Claim ${claimId} (${claimant?.username ?? "unknown"}, RM ${updated.amount.toFixed(2)}) ` +
          (statusChanged ? `marked ${updated.status}` : "edited") +
          ` — ${describeChanges(changes)}`,
        actor: user,
        companyEntityId: updated.entity_id,
        targetType: "claim",
        targetId: updated.claim_id,
        targetLabel: updated.reason,
        changes,
        context: { amount: updated.amount, status: updated.status, moved },
      });
    }

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

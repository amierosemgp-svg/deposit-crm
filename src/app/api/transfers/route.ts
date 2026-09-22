import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, bankTransfers, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import {
  getSettingNumber,
  jsonError,
  transferAllowed,
} from "@/lib/api-helpers";

const createSchema = z.object({
  from_account_id: z.number().int().positive(),
  to_account_id: z.number().int().positive(),
  amount: z.number().positive(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  // Fully manual: the agent never acts on it and it never auto-confirms.
  skip_bot: z.boolean().optional(),
});

/**
 * POST /api/transfers — create a bank transfer.
 * Rules (checked against the entity tree):
 *   company → company under the same leader, or leader → own company.
 * Sender is debited immediately; recipient is credited on confirmation
 * (or automatically when the confirmation window expires).
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;
    if (body.from_account_id === body.to_account_id) {
      return jsonError("Cannot transfer to the same account");
    }

    const result = await db.transaction(async (txn) => {
      const accounts = await txn
        .select()
        .from(bankAccounts)
        .where(
          inArray(bankAccounts.account_id, [
            body.from_account_id,
            body.to_account_id,
          ]),
        )
        .for("update");
      const from = accounts.find((a) => a.account_id === body.from_account_id);
      const to = accounts.find((a) => a.account_id === body.to_account_id);
      if (!from || !to) throw new AuthError(404, "Account not found");

      // Sender must be within the user's managed entities
      if (
        user.ownedEntityIds !== null &&
        !user.ownedEntityIds.includes(from.entity_id)
      ) {
        throw new AuthError(403, "Source account is outside your scope");
      }
      if (from.status !== "active" || to.status !== "active") {
        throw new AuthError(422, "Both accounts must be active");
      }

      const rule = await transferAllowed(from.entity_id, to.entity_id);
      if (!rule.allowed) {
        throw new AuthError(422, rule.reason ?? "Transfer not allowed");
      }
      if (from.current_balance < body.amount) {
        throw new AuthError(
          422,
          `Insufficient balance (${from.current_balance.toFixed(2)} available)`,
        );
      }

      // Manual unless the caller says otherwise — same default as
      // /api/deposits. The desk moves this money in its own banking app and
      // the CRM records what already happened, so a manual transfer lands
      // finished: both sides move now and there is nothing left to confirm.
      // Unticking it hands the transfer to the agent, which still works the
      // old two-phase way — debit now, credit when the recipient confirms.
      const manual = body.skip_bot ?? true;
      const nowIso = new Date().toISOString();
      const hours = manual
        ? 0
        : await getSettingNumber("transfer_auto_confirm_hours", 24);
      const expiresAt = manual
        ? null
        : new Date(Date.now() + hours * 3600_000).toISOString();

      // Debit sender immediately — the amount is never double-spendable
      await txn
        .update(bankAccounts)
        .set({ current_balance: +(from.current_balance - body.amount).toFixed(2) })
        .where(eq(bankAccounts.account_id, from.account_id));

      if (manual) {
        // ...and credit the recipient in the same breath. `to` was locked by
        // the same FOR UPDATE select above, so this balance is not stale.
        await txn
          .update(bankAccounts)
          .set({ current_balance: +(to.current_balance + body.amount).toFixed(2) })
          .where(eq(bankAccounts.account_id, to.account_id));
      }

      const [transfer] = await txn
        .insert(bankTransfers)
        .values({
          from_account_id: from.account_id,
          to_account_id: to.account_id,
          amount: body.amount,
          reference: body.reference?.trim() || `TRF-${Date.now()}`,
          notes: body.notes?.trim() || null,
          // No "completed" in the enum; "confirmed" already means the money
          // is on both sides. The person who booked it is the one who settled
          // it, so they are recorded on both halves.
          status: manual ? "confirmed" : "pending_confirmation",
          skip_bot: manual,
          initiated_by_user_id: user.user_id,
          confirmed_by_user_id: manual ? user.user_id : null,
          confirmed_at: manual ? nowIso : null,
          expires_at: expiresAt,
          created_at: nowIso,
        })
        .returning();

      // Every writing role may move money between the desk's own accounts, so
      // the log names the person and the hat they wore.
      const actor = {
        by: user.full_name || user.username,
        by_role: user.role,
      };

      await txn.insert(transactions).values({
        entity_id: from.entity_id,
        type: "bank_transfer",
        amount: body.amount,
        reference_id: transfer.transfer_id,
        user_id: user.user_id,
        details: {
          action: manual ? "debited" : "initiated",
          from_account: from.account_number,
          to_account: to.account_number,
          ...(expiresAt ? { expires_at: expiresAt } : {}),
          ...actor,
        },
      });

      // The receiving entity gets its own row, the way a confirmation would
      // have written one — otherwise the credit never shows in its money log.
      if (manual) {
        await txn.insert(transactions).values({
          entity_id: to.entity_id,
          type: "bank_transfer",
          amount: body.amount,
          reference_id: transfer.transfer_id,
          user_id: user.user_id,
          details: {
            action: "credited",
            from_account: from.account_number,
            to_account: to.account_number,
            settled: "on creation — handled manually",
            ...actor,
          },
        });
      }

      return transfer;
    });

    return Response.json({ transfer: result }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

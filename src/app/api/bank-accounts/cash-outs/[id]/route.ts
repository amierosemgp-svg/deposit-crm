import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, bankCashOuts, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { moveBankBalance } from "@/lib/bank-balance";

/**
 * DELETE /api/bank-accounts/cash-outs/:id — remove a row that should never
 * have existed, and put the money back on the account.
 *
 * Not the same as reversing, and both are kept on purpose:
 *
 *   reverse  the cash really did go back into the bank. A real event, so the
 *            row stays and reads "Reversed".
 *   delete   the row was a mistake — mistyped, or entered twice. Nothing
 *            happened, so nothing should be on the sheet.
 *
 * Either way the balance ends up the same; what differs is whether the history
 * keeps a record of the movement. Deleting an already-reversed row puts nothing
 * back, because reversing already did.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return jsonError("Bad cash-out id");

    const row = await db.transaction(async (txn) => {
      const [cashOut] = await txn
        .select()
        .from(bankCashOuts)
        .where(eq(bankCashOuts.cash_out_id, id))
        .for("update");
      if (!cashOut) throw new AuthError(404, "Cash-out not found");
      if (user.companyIds !== null && !user.companyIds.includes(cashOut.entity_id)) {
        throw new AuthError(403, "Cash-out is outside your company scope");
      }
      if (user.role !== "super_admin" && cashOut.recorded_by_user_id !== user.user_id) {
        throw new AuthError(
          403,
          "Only the person who recorded it, or an admin, can remove it",
        );
      }

      // A reversed row already gave the money back; refunding again would
      // credit the account twice for one withdrawal.
      const balanceAfter = cashOut.reversed_at
        ? null
        : await moveBankBalance(txn, {
            accountId: cashOut.account_id,
            delta: cashOut.amount,
          });

      const [account] = await txn
        .select({ entity_id: bankAccounts.entity_id, label: bankAccounts.label })
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, cashOut.account_id));

      await txn.insert(transactions).values({
        entity_id: account?.entity_id ?? cashOut.entity_id,
        type: "bank_cash_out",
        amount: -cashOut.amount,
        user_id: user.user_id,
        details: {
          action: "cash_out_deleted",
          cash_out_id: cashOut.cash_out_id,
          account: account?.label ?? `#${cashOut.account_id}`,
          taken_by: cashOut.taken_by,
          amount: cashOut.amount,
          occurred_at: cashOut.occurred_at,
          notes: cashOut.notes,
          was_reversed: cashOut.reversed_at !== null,
          ...(balanceAfter !== null ? { balance_after: balanceAfter } : {}),
        },
      });

      await txn.delete(bankCashOuts).where(eq(bankCashOuts.cash_out_id, id));
      return { cashOut, label: account?.label ?? `#${cashOut.account_id}` };
    });

    await logActivity({
      category: "bank_account",
      action: "bank_cash_out.deleted",
      summary:
        `Clear bank deleted: ${row.cashOut.taken_by} took ` +
        `RM ${row.cashOut.amount.toFixed(2)} from ${row.label}`,
      actor: user,
      companyEntityId: row.cashOut.entity_id,
      targetType: "bank_cash_out",
      targetId: row.cashOut.cash_out_id,
      targetLabel: row.label,
      context: {
        amount: row.cashOut.amount,
        taken_by: row.cashOut.taken_by,
        was_reversed: row.cashOut.reversed_at !== null,
      },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

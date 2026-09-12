import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, bankCashOuts, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";

/**
 * POST /api/bank-accounts/cash-outs/:id/reverse — undo a recorded cash-out:
 * the amount goes back on the account and the row stays as history, marked
 * reversed. Leaders and admins only — it changes a balance CS already
 * reconciled against a receipt.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireWriteUser();
    if (user.role !== "super_admin" && user.role !== "company_leader") {
      throw new AuthError(403, "Only a leader or admin reverses a cash-out");
    }
    const id = Number((await ctx.params).id);
    if (!Number.isInteger(id) || id <= 0) return jsonError("Bad cash-out id");

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(bankCashOuts)
        .where(eq(bankCashOuts.cash_out_id, id))
        .for("update");
      if (!row) throw new AuthError(404, "Cash-out not found");
      if (user.companyIds !== null && !user.companyIds.includes(row.entity_id)) {
        throw new AuthError(403, "Cash-out is outside your company scope");
      }
      if (row.reversed_at) throw new AuthError(409, "Already reversed");

      const [account] = await txn
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, row.account_id))
        .for("update");
      if (!account) throw new AuthError(404, "Account not found");

      const nowIso = new Date().toISOString();
      await txn
        .update(bankAccounts)
        .set({ current_balance: +(account.current_balance + row.amount).toFixed(2) })
        .where(eq(bankAccounts.account_id, account.account_id));
      const [updated] = await txn
        .update(bankCashOuts)
        .set({ reversed_at: nowIso, reversed_by_user_id: user.user_id })
        .where(eq(bankCashOuts.cash_out_id, id))
        .returning();

      await txn.insert(transactions).values({
        entity_id: account.entity_id,
        type: "bank_cash_out",
        amount: row.amount,
        reference_id: row.cash_out_id,
        user_id: user.user_id,
        details: {
          action: "reversed",
          account: account.account_number,
          bank: account.bank_name,
          taken_by: row.taken_by,
          balance_after: +(account.current_balance + row.amount).toFixed(2),
        },
      });

      return { updated, account };
    });

    await logActivity({
      category: "bank_account",
      action: "bank_account.cash_out_reversed",
      summary: `Cash-out of RM ${result.updated.amount.toFixed(2)} from ${result.account.bank_name} ${
        result.account.account_number
      } reversed — amount back on the account`,
      actor: user,
      companyEntityId: result.account.entity_id,
      targetType: "bank_account",
      targetId: result.account.account_id,
      targetLabel: `${result.account.bank_name} ${result.account.account_number}`,
      context: { cash_out_id: id, amount: result.updated.amount },
    });

    return Response.json({ cash_out: result.updated });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

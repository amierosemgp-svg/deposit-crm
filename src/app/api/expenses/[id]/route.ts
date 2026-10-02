import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, entities, expenses, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { describeChanges, diffFields, logActivity } from "@/lib/activity-log";
import { InsufficientBankBalanceError, moveBankBalance } from "@/lib/bank-balance";
import { EXPENSE_CATEGORIES } from "@/lib/types";

const patchSchema = z
  .object({
    expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    category: z.enum(EXPENSE_CATEGORIES).optional(),
    description: z.string().min(1).max(200).optional(),
    amount: z.number().positive().optional(),
    company_entity_id: z.number().int().positive().nullable().optional(),
    notes: z.string().nullable().optional(),
    // The Paid-from cell is one choice: an account, a leader's cash, or
    // nothing. Naming either side replaces the pair, so switching a row from
    // an account to cash doesn't leave it claiming both.
    paid_from_account_id: z.number().int().positive().nullable().optional(),
    paid_from_cash_entity_id: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => !(v.paid_from_account_id && v.paid_from_cash_entity_id), {
    message: "An expense is paid from a bank account or from cash, not both",
    path: ["paid_from_account_id"],
  });

/**
 * PATCH /api/expenses/:id — correct any typed-in cell of an expense row.
 *
 * Anyone who can write may correct one in a company they work for, whoever
 * recorded it. The recorder-only rule on DELETE is about making a row vanish;
 * an edit keeps the row and puts the before/after on the log, and a figure
 * only its author may fix is a figure that stays wrong until they are back on
 * shift.
 *
 * An expense paid from an account has already taken its money, so changing
 * the amount or the account re-books it in the same database transaction,
 * under a lock on the row: the old account gets the old amount back, then the
 * new account pays the new amount. Done as two moves rather than a net delta
 * on purpose — each one is a `transactions` row the History page can show, and
 * "refunded 500 to Maybank, paid 50 from Maybank" reads true where "+450" does
 * not. A leader's own cash moves no company balance, so switching to or from
 * cash only books the account side.
 *
 * Refuses, as POST does, when the new account can't cover the new amount —
 * with nothing moved, since the whole edit rolls back.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const isAdmin = user.role === "super_admin";
    const expenseId = Number((await params).id);
    if (!Number.isInteger(expenseId) || expenseId <= 0) return jsonError("Bad expense id");

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    }
    const body = parsed.data;
    const paidFromNamed =
      body.paid_from_account_id !== undefined || body.paid_from_cash_entity_id !== undefined;

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(expenses)
        .where(eq(expenses.expense_id, expenseId))
        .for("update");
      if (!row) throw new AuthError(404, "Expense not found");

      // Scope, not authorship: the row has to sit in one of the caller's
      // companies, and so does wherever they move it to. Same rule POST uses.
      const inScope = (companyId: number | null) =>
        companyId != null && (user.companyIds === null || user.companyIds.includes(companyId));
      if (!isAdmin && !inScope(row.company_entity_id)) {
        throw new AuthError(403, "Expense is outside your company scope");
      }
      if (body.company_entity_id !== undefined && body.company_entity_id !== row.company_entity_id) {
        if (!isAdmin && !inScope(body.company_entity_id)) {
          throw new AuthError(403, "Record the expense against one of your own companies");
        }
        if (body.company_entity_id != null) {
          const [company] = await txn
            .select()
            .from(entities)
            .where(eq(entities.entity_id, body.company_entity_id));
          if (!company || company.entity_type !== "company") {
            throw new AuthError(400, `Entity ${body.company_entity_id} is not a company`);
          }
        }
      }

      const next = {
        expense_date: body.expense_date ?? row.expense_date,
        category: body.category ?? row.category,
        description: body.description ?? row.description,
        amount: body.amount ?? row.amount,
        company_entity_id:
          body.company_entity_id !== undefined ? body.company_entity_id : row.company_entity_id,
        notes: body.notes !== undefined ? body.notes || null : row.notes,
        paid_from_account_id: paidFromNamed
          ? (body.paid_from_account_id ?? null)
          : row.paid_from_account_id,
        paid_from_cash_entity_id: paidFromNamed
          ? (body.paid_from_cash_entity_id ?? null)
          : row.paid_from_cash_entity_id,
      };

      // A newly named account or leader is checked exactly as POST checks it.
      // Leaving the row's existing one alone is never re-checked: correcting a
      // description shouldn't fail because an admin once paid it from an
      // account this user can't see.
      if (
        next.paid_from_account_id != null &&
        next.paid_from_account_id !== row.paid_from_account_id
      ) {
        const [account] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, next.paid_from_account_id));
        if (!account) throw new AuthError(404, "Bank account not found");
        if (user.ownedEntityIds !== null && !user.ownedEntityIds.includes(account.entity_id)) {
          throw new AuthError(403, "That bank account is outside your organisation");
        }
      }
      if (
        next.paid_from_cash_entity_id != null &&
        next.paid_from_cash_entity_id !== row.paid_from_cash_entity_id
      ) {
        // Pointing a row at a leader's pocket is a settlement between them and
        // the business — the admin's book, on an edit as much as on POST.
        if (!isAdmin) {
          throw new AuthError(403, "Only admins record payments from a leader's cash");
        }
        const [leader] = await txn
          .select()
          .from(entities)
          .where(eq(entities.entity_id, next.paid_from_cash_entity_id));
        if (!leader) throw new AuthError(404, "Leader not found");
        if (leader.entity_type !== "leader") {
          throw new AuthError(400, "Cash is held by a leader — pick a leader, not a company");
        }
        if (user.ownedEntityIds !== null && !user.ownedEntityIds.includes(leader.entity_id)) {
          throw new AuthError(403, "That leader is outside your organisation");
        }
      }

      // expense_date is a timestamp column fed a bare date; compare the day,
      // or every save would log a "change" from "2026-10-01 00:00:00+08".
      const changes = diffFields(
        { ...row, expense_date: row.expense_date.slice(0, 10) },
        {
          ...next,
          expense_date: body.expense_date ?? row.expense_date.slice(0, 10),
        },
      );
      if (!changes.length) return { row, changes, movements: [] };

      const rebook =
        row.paid_from_account_id !== next.paid_from_account_id || row.amount !== next.amount;
      const movements: { account_id: number; delta: number; balance_after: number }[] = [];
      if (rebook) {
        // Lock both accounts in id order before moving either, so two edits
        // swapping the same pair of accounts can't deadlock each other.
        const ids = [row.paid_from_account_id, next.paid_from_account_id].filter(
          (v): v is number => v != null,
        );
        if (ids.length) {
          await txn
            .select({ id: bankAccounts.account_id })
            .from(bankAccounts)
            .where(inArray(bankAccounts.account_id, ids))
            .orderBy(asc(bankAccounts.account_id))
            .for("update");
        }
        if (row.paid_from_account_id != null) {
          movements.push({
            account_id: row.paid_from_account_id,
            delta: row.amount,
            balance_after: await moveBankBalance(txn, {
              accountId: row.paid_from_account_id,
              delta: row.amount,
            }),
          });
        }
        if (next.paid_from_account_id != null) {
          movements.push({
            account_id: next.paid_from_account_id,
            delta: -next.amount,
            balance_after: await moveBankBalance(txn, {
              accountId: next.paid_from_account_id,
              delta: -next.amount,
            }),
          });
        }
      }

      const [updated] = await txn
        .update(expenses)
        .set(next)
        .where(eq(expenses.expense_id, expenseId))
        .returning();

      for (const m of movements) {
        const [account] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, m.account_id));
        await txn.insert(transactions).values({
          entity_id: account?.entity_id ?? updated.company_entity_id,
          type: "expense",
          amount: Math.abs(m.delta),
          reference_id: updated.expense_id,
          user_id: user.user_id,
          details: {
            // The refund of the old booking, then the new booking.
            action: m.delta > 0 ? "expense_edit_refunded" : "expense_edit_paid",
            category: updated.category,
            description: updated.description,
            account_id: m.account_id,
            bank: account ? `${account.bank_name} ${account.account_number}` : null,
            balance_after: m.balance_after,
            changes,
          },
        });
      }
      return { row: updated, changes, movements };
    });

    if (result.changes.length) {
      await logActivity({
        category: "expense",
        action: "expense.updated",
        summary: `Expense edited: ${result.row.description} — ${describeChanges(result.changes)}`,
        actor: user,
        companyEntityId: result.row.company_entity_id,
        targetType: "expense",
        targetId: result.row.expense_id,
        targetLabel: result.row.description,
        changes: result.changes,
        context: result.movements.length ? { rebooked: result.movements } : undefined,
      });
    }

    return Response.json({ expense: result.row });
  } catch (e) {
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/**
 * DELETE /api/expenses/:id — remove a mistaken entry, and put the money back.
 *
 * Admins delete anything. Anyone else may undo one they recorded themselves:
 * they can enter expenses, so leaving them unable to fix a mistyped one would
 * just mean an admin doing it later from a worse description.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const isAdmin = user.role === "super_admin";
    const { id } = await params;

    if (!isAdmin) {
      const [row] = await db
        .select()
        .from(expenses)
        .where(eq(expenses.expense_id, Number(id)));
      if (!row) return jsonError("Expense not found", 404);
      if (row.recorded_by_user_id !== user.user_id) {
        throw new AuthError(403, "Only the person who recorded it, or an admin, can remove it");
      }
    }

    // Deleting an expense that was paid from an account puts the money back,
    // in the same step. Otherwise removing a mistyped row would leave the
    // balance short by it for good.
    const deleted = await db.transaction(async (txn) => {
      const [row] = await txn
        .delete(expenses)
        .where(eq(expenses.expense_id, Number(id)))
        .returning();
      if (!row) return null;
      if (row.paid_from_account_id != null) {
        const balance = await moveBankBalance(txn, {
          accountId: row.paid_from_account_id,
          delta: row.amount,
        });
        const [account] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, row.paid_from_account_id));
        await txn.insert(transactions).values({
          entity_id: account?.entity_id ?? row.company_entity_id,
          type: "expense",
          amount: row.amount,
          reference_id: row.expense_id,
          user_id: user.user_id,
          details: {
            action: "expense_deleted",
            category: row.category,
            description: row.description,
            account_id: row.paid_from_account_id,
            balance_after: balance,
          },
        });
      }
      return row;
    });
    if (!deleted) return jsonError("Expense not found", 404);

    await logActivity({
      category: "expense",
      action: "expense.deleted",
      summary: `Expense deleted: ${deleted.description} — RM ${deleted.amount.toFixed(2)} (${deleted.category})`,
      actor: user,
      companyEntityId: deleted.company_entity_id,
      targetType: "expense",
      targetId: deleted.expense_id,
      targetLabel: deleted.description,
      context: { amount: deleted.amount, category: deleted.category },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

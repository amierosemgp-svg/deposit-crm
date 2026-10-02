import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, bankCashOuts, entities, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { describeChanges, diffFields, logActivity } from "@/lib/activity-log";
import { InsufficientBankBalanceError, moveBankBalance } from "@/lib/bank-balance";

const patchSchema = z.object({
  account_id: z.number().int().positive().optional(),
  amount: z.number().positive().max(10_000_000).optional(),
  // The leader who took it; null unlinks the row from a leader entity and
  // leaves the free-text name standing.
  taken_by_entity_id: z.number().int().positive().nullable().optional(),
  taken_by: z.string().trim().max(120).optional(),
  // Date and time are one instant on the row; the sheet's two cells send it
  // back together.
  occurred_at: z.string().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  // The Status cell. "reversed" means the cash went back into the bank.
  status: z.enum(["active", "reversed"]).optional(),
});

/**
 * PATCH /api/bank-accounts/cash-outs/:id — correct a Clear Bank row, Status
 * included.
 *
 * Anyone who can write in the row's company may correct it, whoever recorded
 * it — the recorder-or-admin rule below is DELETE's, for making a row vanish.
 * An edit keeps the row and puts the before/after on the log.
 *
 * A live cash-out has already taken its money off the account, so an edit that
 * touches the money re-books it in one database transaction, under a lock on
 * the row: undo the old booking, then lay down the new one.
 *
 *   amount / account   old account gets the old amount back, new account pays
 *                      the new amount.
 *   active → reversed  old account gets the old amount back; nothing new is
 *                      booked. What POST …/reverse does, from the sheet.
 *   reversed → active  nothing to undo (reversing already refunded it); the
 *                      new account pays the new amount again.
 *   reversed, stays    no money moves — a reversed row holds no booking, so
 *                      fixing its amount is just fixing the history.
 *
 * Two moves rather than a net delta on purpose: each is a `transactions` row,
 * and "refunded 500, took 50" is what happened on the History page. The new
 * debit is refused, as on POST, when the account can't cover it; the whole edit
 * rolls back with it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return jsonError("Bad cash-out id");

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    const body = parsed.data;

    let occurredAt: string | undefined;
    if (body.occurred_at !== undefined) {
      const when = new Date(body.occurred_at);
      if (Number.isNaN(when.getTime())) return jsonError("Bad occurred_at");
      if (when.getTime() > Date.now() + 5 * 60_000) {
        return jsonError("The withdrawal time can't be in the future");
      }
      occurredAt = when.toISOString();
    }

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

      // Moving the row to another account moves it to that account's company,
      // which has to be the caller's too — and has to be open for business,
      // as POST requires.
      let entityId = row.entity_id;
      if (body.account_id !== undefined && body.account_id !== row.account_id) {
        const [account] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, body.account_id));
        if (!account) throw new AuthError(404, "Account not found");
        if (user.companyIds !== null && !user.companyIds.includes(account.entity_id)) {
          throw new AuthError(403, "Account is outside your company scope");
        }
        if (account.status !== "active") throw new AuthError(422, "Account is inactive");
        entityId = account.entity_id;
      }

      // Who took it, resolved as POST resolves it: a named leader fills in the
      // name unless one was typed.
      let takenBy = body.taken_by ?? row.taken_by;
      let takenByEntityId = row.taken_by_entity_id;
      if (body.taken_by_entity_id !== undefined) {
        takenByEntityId = body.taken_by_entity_id;
        if (body.taken_by_entity_id != null && body.taken_by_entity_id !== row.taken_by_entity_id) {
          const [leader] = await txn
            .select({ entity_id: entities.entity_id, name: entities.name })
            .from(entities)
            .where(eq(entities.entity_id, body.taken_by_entity_id));
          if (!leader) throw new AuthError(404, "Leader not found");
          if (body.taken_by === undefined) takenBy = leader.name;
        }
      }
      if (!takenBy) throw new AuthError(422, "Say who took the cash");

      const wasReversed = row.reversed_at !== null;
      const willBeReversed = body.status ? body.status === "reversed" : wasReversed;
      const next = {
        account_id: body.account_id ?? row.account_id,
        entity_id: entityId,
        amount: body.amount ?? row.amount,
        taken_by_entity_id: takenByEntityId,
        taken_by: takenBy,
        occurred_at: occurredAt ?? row.occurred_at,
        notes: body.notes !== undefined ? body.notes || null : row.notes,
      };

      // Timestamps come back from Postgres as "2026-10-01 14:00:00+00"; compare
      // instants, or every save would log a change to the same moment.
      const changes = diffFields(
        {
          ...row,
          occurred_at: new Date(row.occurred_at).toISOString(),
          status: wasReversed ? "reversed" : "active",
        },
        {
          ...next,
          occurred_at: new Date(next.occurred_at).toISOString(),
          status: willBeReversed ? "reversed" : "active",
        },
      );
      if (!changes.length) return { row, changes, movements: [] };

      // The old booking exists only while the row is live; the new one only if
      // it stays (or becomes) live. Re-book when either side differs.
      const oldBooking = wasReversed ? null : { accountId: row.account_id, amount: row.amount };
      const newBooking = willBeReversed
        ? null
        : { accountId: next.account_id, amount: next.amount };
      const rebook = JSON.stringify(oldBooking) !== JSON.stringify(newBooking);

      const movements: { account_id: number; delta: number; balance_after: number }[] = [];
      if (rebook) {
        // Lock both accounts in id order before moving either, so two edits
        // swapping the same pair of accounts can't deadlock each other.
        const ids = [oldBooking?.accountId, newBooking?.accountId].filter(
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
        if (oldBooking) {
          movements.push({
            account_id: oldBooking.accountId,
            delta: oldBooking.amount,
            balance_after: await moveBankBalance(txn, {
              accountId: oldBooking.accountId,
              delta: oldBooking.amount,
            }),
          });
        }
        if (newBooking) {
          movements.push({
            account_id: newBooking.accountId,
            delta: -newBooking.amount,
            balance_after: await moveBankBalance(txn, {
              accountId: newBooking.accountId,
              delta: -newBooking.amount,
            }),
          });
        }
      }

      const [updated] = await txn
        .update(bankCashOuts)
        .set({
          ...next,
          // Reversing stamps who and when; un-reversing clears both, since the
          // row is live again and nothing about it is reversed.
          ...(willBeReversed !== wasReversed
            ? willBeReversed
              ? { reversed_at: new Date().toISOString(), reversed_by_user_id: user.user_id }
              : { reversed_at: null, reversed_by_user_id: null }
            : {}),
        })
        .where(eq(bankCashOuts.cash_out_id, id))
        .returning();

      for (const m of movements) {
        const [account] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, m.account_id));
        await txn.insert(transactions).values({
          entity_id: account?.entity_id ?? updated.entity_id,
          type: "bank_cash_out",
          // Unsigned, as the "recorded" and "reversed" rows are; the action
          // says which way the money went.
          amount: Math.abs(m.delta),
          reference_id: updated.cash_out_id,
          user_id: user.user_id,
          details: {
            action: m.delta > 0 ? "edit_refunded" : "edit_recorded",
            account: account?.account_number ?? `#${m.account_id}`,
            bank: account?.bank_name ?? null,
            taken_by: updated.taken_by,
            occurred_at: updated.occurred_at,
            balance_after: m.balance_after,
            changes,
          },
        });
      }

      return { row: updated, changes, movements };
    });

    if (result.changes.length) {
      const [account] = await db
        .select({ label: bankAccounts.label })
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, result.row.account_id));
      const label = account?.label ?? `#${result.row.account_id}`;
      await logActivity({
        category: "bank_account",
        action: "bank_cash_out.updated",
        summary: `Clear bank edited (${result.row.taken_by}, ${label}): ${describeChanges(
          result.changes,
        )}`,
        actor: user,
        companyEntityId: result.row.entity_id,
        targetType: "bank_cash_out",
        targetId: result.row.cash_out_id,
        targetLabel: label,
        changes: result.changes,
        context: result.movements.length ? { rebooked: result.movements } : undefined,
      });
    }

    return Response.json({ cash_out: result.row });
  } catch (e) {
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

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

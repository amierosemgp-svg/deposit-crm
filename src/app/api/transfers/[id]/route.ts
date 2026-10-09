import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, bankTransfers, entities, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError, transferAllowed, transferEntityIds } from "@/lib/api-helpers";
import { companyOfEntity, describeChanges, diffFields, logActivity } from "@/lib/activity-log";
import { InsufficientBankBalanceError, moveBankBalance } from "@/lib/bank-balance";

const patchSchema = z.object({
  from_account_id: z.number().int().positive().optional(),
  to_account_id: z.number().int().positive().optional(),
  amount: z.number().positive().optional(),
  notes: z.string().max(500).nullable().optional(),
});

/**
 * PATCH /api/transfers/:id — correct a settled bank transfer: either account,
 * the amount, the notes.
 *
 * The usual mistake is the receiving account: two companies each have an
 * "MBB 2-ENT", and picking the wrong company's one credits the wrong bank.
 * Before this the only fix was a hand correction in the database.
 *
 * Who: anyone who could have sent it — a leader of either company, an admin,
 * a CS desk within its company family (transferEntityIds) — both before the
 * edit (may touch it at all) and after (may not move it out to two companies
 * they don't hold). The new pair must be one POST would allow.
 *
 * A settled transfer already moved both balances, so an edit that touches the
 * money re-books it in one transaction under a lock on the row: the old debit
 * and credit come off, the new ones go on, netted per account so a 1,000 →
 * 1,200 correction is a 200 movement and not a 1,000 refund racing a 1,200
 * debit. Credits go on before debits, and a debit the account can't cover is
 * refused (moveBankBalance) and the whole edit rolls back. Each account that
 * moved gets a ledger row, and the System Log carries the before and after.
 *
 * Only settled transfers: a pending one is confirmed or rejected, not edited.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const transferId = Number((await params).id);
    if (!Number.isInteger(transferId) || transferId <= 0) return jsonError("Bad transfer id");

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    }
    const body = parsed.data;

    const scope =
      user.role === "cs_agent" ? await transferEntityIds(user) : user.ownedEntityIds;
    const inScope = (entityId: number) => scope === null || scope.includes(entityId);

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(bankTransfers)
        .where(eq(bankTransfers.transfer_id, transferId))
        .for("update");
      if (!row) throw new AuthError(404, "Transfer not found");
      if (row.status !== "confirmed" && row.status !== "auto_confirmed") {
        throw new AuthError(
          409,
          row.status === "pending_confirmation"
            ? "This transfer is still pending — confirm or reject it instead"
            : `A ${row.status} transfer can't be edited`,
        );
      }

      const next = {
        from_account_id: body.from_account_id ?? row.from_account_id,
        to_account_id: body.to_account_id ?? row.to_account_id,
        amount: body.amount ?? row.amount,
        notes: body.notes === undefined ? row.notes : body.notes?.trim() || null,
      };
      if (next.from_account_id === next.to_account_id) {
        throw new AuthError(422, "Source and destination must differ");
      }

      const ids = [
        ...new Set([row.from_account_id, row.to_account_id, next.from_account_id, next.to_account_id]),
      ];
      const accounts = await txn
        .select()
        .from(bankAccounts)
        .where(inArray(bankAccounts.account_id, ids));
      const byId = new Map(accounts.map((a) => [a.account_id, a]));
      const oldFrom = byId.get(row.from_account_id);
      const oldTo = byId.get(row.to_account_id);
      const newFrom = byId.get(next.from_account_id);
      const newTo = byId.get(next.to_account_id);
      if (!oldFrom || !oldTo || !newFrom || !newTo) throw new AuthError(404, "Account not found");

      if (!inScope(oldFrom.entity_id) && !inScope(oldTo.entity_id)) {
        throw new AuthError(403, "This transfer is outside your scope");
      }
      const endsChanged =
        next.from_account_id !== row.from_account_id || next.to_account_id !== row.to_account_id;
      if (endsChanged) {
        if (!inScope(newFrom.entity_id) && !inScope(newTo.entity_id)) {
          throw new AuthError(403, "Neither account is in your scope");
        }
        // An account newly named has to be open for business, as on POST; one
        // the row already had may have closed since and still be kept.
        for (const a of [newFrom, newTo]) {
          const isNew = a.account_id !== row.from_account_id && a.account_id !== row.to_account_id;
          if (isNew && a.status !== "active") {
            throw new AuthError(422, `${a.bank_name} ${a.account_number} is inactive`);
          }
        }
        const rule = await transferAllowed(newFrom.entity_id, newTo.entity_id);
        if (!rule.allowed) throw new AuthError(422, rule.reason ?? "Transfer not allowed");
      }

      const changes = diffFields(
        {
          from_account: `${oldFrom.bank_name} ${oldFrom.account_number}`,
          to_account: `${oldTo.bank_name} ${oldTo.account_number}`,
          amount: row.amount,
          notes: row.notes,
        },
        {
          from_account: `${newFrom.bank_name} ${newFrom.account_number}`,
          to_account: `${newTo.bank_name} ${newTo.account_number}`,
          amount: next.amount,
          notes: next.notes,
        },
      );
      if (!changes.length) return { row, saved: row, changes, balances: {} as Record<string, number> };

      // Net movement per account: undo the old pair, lay down the new one.
      const delta = new Map<number, number>();
      const add = (id: number, d: number) => delta.set(id, +((delta.get(id) ?? 0) + d).toFixed(2));
      add(row.from_account_id, row.amount);
      add(row.to_account_id, -row.amount);
      add(next.from_account_id, -next.amount);
      add(next.to_account_id, next.amount);

      const actor = { by: user.full_name || user.username, by_role: user.role };
      const balances: Record<string, number> = {};
      const moves = [...delta.entries()]
        .filter(([, d]) => d !== 0)
        .sort((a, b) => b[1] - a[1]); // credits first, so a debit sees them
      for (const [accountId, d] of moves) {
        const account = byId.get(accountId)!;
        const after = await moveBankBalance(txn, { accountId, delta: d });
        balances[account.account_number] = after;
        await txn.insert(transactions).values({
          entity_id: account.entity_id,
          type: "bank_transfer",
          amount: Math.abs(d),
          reference_id: transferId,
          user_id: user.user_id,
          details: {
            action: d > 0 ? "edit_credited" : "edit_debited",
            account: account.account_number,
            from_account: newFrom.account_number,
            to_account: newTo.account_number,
            correction: describeChanges(changes),
            balance_after: after,
            ...actor,
          },
        });
      }

      const [saved] = await txn
        .update(bankTransfers)
        .set(next)
        .where(eq(bankTransfers.transfer_id, transferId))
        .returning();

      const names = await txn
        .select({ id: entities.entity_id, name: entities.name })
        .from(entities)
        .where(inArray(entities.entity_id, [newFrom.entity_id, newTo.entity_id]));
      const nameOf = (id: number) => names.find((n) => n.id === id)?.name ?? "?";
      return {
        row,
        saved,
        changes,
        balances,
        route: `${nameOf(newFrom.entity_id)} → ${nameOf(newTo.entity_id)}`,
        companyEntityId: newFrom.entity_id,
      };
    });

    if (result.changes.length) {
      await logActivity({
        category: "bank_account",
        action: "bank_transfer.edited",
        summary:
          `Bank transfer ${transferId} edited (${"route" in result ? result.route : ""}) — ` +
          describeChanges(result.changes),
        actor: user,
        companyEntityId:
          "companyEntityId" in result ? await companyOfEntity(result.companyEntityId) : null,
        targetType: "bank_transfer",
        targetId: transferId,
        changes: result.changes,
        context: { balances: result.balances },
      });
    }

    return Response.json({ transfer: result.saved });
  } catch (e) {
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

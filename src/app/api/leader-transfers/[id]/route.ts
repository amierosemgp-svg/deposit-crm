import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  bankAccounts,
  entities,
  leaderMemberships,
  leaderTransfers,
  transactions,
  users,
} from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError, leaderTransferEntityIds, transferEntityIds } from "@/lib/api-helpers";
import { describeChanges, diffFields, logActivity } from "@/lib/activity-log";
import { InsufficientBankBalanceError, moveBankBalance } from "@/lib/bank-balance";

/**
 * Every typed-in cell of a saved settlement, each optional.
 *
 * An end is replaced whole: naming either half of it (`from_account_id` or
 * `from_cash`) sets that end to exactly what was sent, and the half left out
 * falls back to "not that" — so `{ from_cash: true }` clears the account, and
 * `{ from_account_id: 7 }` clears cash. Sending `{ from_account_id: null }`
 * alone puts the end back to "not recorded". Patching half an end and keeping
 * the other half from the row would let a cell edit produce a row that is
 * both an account and cash, which is the one state the sheet cannot show.
 */
const patchSchema = z
  .object({
    from_leader_user_id: z.number().int().positive().optional(),
    to_leader_user_id: z.number().int().positive().optional(),
    amount: z.number().positive().optional(),
    note: z.string().max(300).nullable().optional(),
    from_account_id: z.number().int().positive().nullable().optional(),
    to_account_id: z.number().int().positive().nullable().optional(),
    from_cash: z.boolean().optional(),
    to_cash: z.boolean().optional(),
    from_bank_transfer: z.boolean().optional(),
    to_bank_transfer: z.boolean().optional(),
    /** The Date and Time cells — the row's only timestamp is when it was keyed. */
    created_at: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => [v.from_cash, v.from_bank_transfer, v.from_account_id].filter(Boolean).length <= 1, {
    message: "The sending end is one of: a bank account, cash, or a bank transfer",
    path: ["from_account_id"],
  })
  .refine((v) => [v.to_cash, v.to_bank_transfer, v.to_account_id].filter(Boolean).length <= 1, {
    message: "The receiving end is one of: a bank account, cash, or a bank transfer",
    path: ["to_account_id"],
  })
  .refine((v) => !(v.from_cash && v.from_account_id), {
    message: "The sending end is a bank account or cash, not both",
    path: ["from_account_id"],
  })
  .refine((v) => !(v.to_cash && v.to_account_id), {
    message: "The receiving end is a bank account or cash, not both",
    path: ["to_account_id"],
  });

/**
 * PATCH /api/leader-transfers/:id — correct a saved settlement, any cell.
 *
 * Anyone who can write may correct one, not just whoever keyed it. The person
 * who notices a settlement is wrong is usually not the person who typed it —
 * it is whoever is reconciling the bank at the end of the shift — and making
 * them find the recorder, or an admin, is how a wrong row stays wrong. What
 * still holds is the scope rule POST applies: one end has to be yours, both
 * before the edit (you may touch it at all) and after (you may not move a
 * settlement out to two organisations you don't belong to).
 *
 * A settlement that names an account moved that account's balance when it was
 * saved, so changing the amount or either end re-books it: the old movements
 * come off, the new ones go on, in one transaction under a lock on the row.
 * The two are netted per account before anything moves — editing RM 1,000
 * into the company Maybank to RM 1,200 is a RM 200 credit, not a RM 1,000
 * debit that might bounce off a balance spent since, followed by a RM 1,200
 * credit. Cash ends moved nothing and so un-move nothing.
 *
 * Validation is POST's, applied to the row as it will be after the edit: both
 * people must be leaders, a named account must belong to a company the leader
 * on that side holds, and a leader paying themselves needs two different
 * ends. Those checks only run against a side that actually changed — a leader
 * who has since given up a company should not make the note on last month's
 * settlement uneditable.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const transferId = Number((await params).id);
    if (!Number.isInteger(transferId)) return jsonError("Bad leader transfer id");

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    }
    const body = parsed.data;

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(leaderTransfers)
        .where(eq(leaderTransfers.transfer_id, transferId))
        .for("update");
      if (!row) throw new AuthError(404, "Leader transfer not found");

      // The row as it will be. An end named in the body replaces the end whole.
      const fromEndTouched =
        body.from_account_id !== undefined ||
        body.from_cash !== undefined ||
        body.from_bank_transfer !== undefined;
      const toEndTouched =
        body.to_account_id !== undefined ||
        body.to_cash !== undefined ||
        body.to_bank_transfer !== undefined;
      const note = body.note === undefined ? row.note : body.note?.trim() || null;
      const next = {
        from_leader_user_id: body.from_leader_user_id ?? row.from_leader_user_id,
        to_leader_user_id: body.to_leader_user_id ?? row.to_leader_user_id,
        amount: body.amount ?? row.amount,
        from_account_id: fromEndTouched ? (body.from_account_id ?? null) : row.from_account_id,
        from_cash: fromEndTouched ? (body.from_cash ?? false) : row.from_cash,
        from_bank_transfer: fromEndTouched
          ? (body.from_bank_transfer ?? false)
          : row.from_bank_transfer,
        to_account_id: toEndTouched ? (body.to_account_id ?? null) : row.to_account_id,
        to_cash: toEndTouched ? (body.to_cash ?? false) : row.to_cash,
        to_bank_transfer: toEndTouched ? (body.to_bank_transfer ?? false) : row.to_bank_transfer,
        note,
        created_at: body.created_at ?? row.created_at,
      };
      const fromSideChanged =
        next.from_leader_user_id !== row.from_leader_user_id ||
        next.from_account_id !== row.from_account_id;
      const toSideChanged =
        next.to_leader_user_id !== row.to_leader_user_id ||
        next.to_account_id !== row.to_account_id;
      const endsChanged =
        fromSideChanged ||
        toSideChanged ||
        next.from_cash !== row.from_cash ||
        next.to_cash !== row.to_cash ||
        next.from_bank_transfer !== row.from_bank_transfer ||
        next.to_bank_transfer !== row.to_bank_transfer;

      // Same leader, same end: the rule POST refuses a new row on.
      if (endsChanged && next.from_leader_user_id === next.to_leader_user_id) {
        const sameAccount =
          next.from_account_id != null && next.from_account_id === next.to_account_id;
        const bothCash = next.from_cash && next.to_cash;
        const bothBank = next.from_bank_transfer && next.to_bank_transfer;
        const neither =
          next.from_account_id == null &&
          next.to_account_id == null &&
          !next.from_cash &&
          !next.to_cash &&
          !next.from_bank_transfer &&
          !next.to_bank_transfer;
        if (sameAccount || bothCash || bothBank || neither) {
          throw new AuthError(
            400,
            "A leader moving money to themselves needs two different ends — " +
              "one account to another, or between an account and cash",
          );
        }
      }

      const personIds = [
        ...new Set([
          row.from_leader_user_id,
          row.to_leader_user_id,
          next.from_leader_user_id,
          next.to_leader_user_id,
        ]),
      ];
      const people = await txn
        .select({
          user_id: users.user_id,
          full_name: users.full_name,
          role: users.role,
          entity_id: users.entity_id,
        })
        .from(users)
        .where(inArray(users.user_id, personIds));
      const personById = new Map(people.map((p) => [p.user_id, p]));
      const from = personById.get(next.from_leader_user_id);
      const to = personById.get(next.to_leader_user_id);
      if (next.from_leader_user_id !== row.from_leader_user_id) {
        if (!from || from.role !== "company_leader") throw new AuthError(400, "From is not a leader");
      }
      if (next.to_leader_user_id !== row.to_leader_user_id) {
        if (!to || to.role !== "company_leader") throw new AuthError(400, "To is not a leader");
      }

      // Each person's companies: the one they sit on plus any granted.
      const memberships = await txn
        .select({
          user_id: leaderMemberships.user_id,
          leader_entity_id: leaderMemberships.leader_entity_id,
        })
        .from(leaderMemberships)
        .where(inArray(leaderMemberships.user_id, personIds));
      const companiesOf = (userId: number) => {
        const p = personById.get(userId);
        return [
          ...(p ? [p.entity_id] : []),
          ...memberships.filter((m) => m.user_id === userId).map((m) => m.leader_entity_id),
        ];
      };

      // One end yours — before the edit, and after it.
      const visible = await leaderTransferEntityIds(user);
      const inScope = (a: number, b: number) =>
        visible === null || [...companiesOf(a), ...companiesOf(b)].some((id) => visible.includes(id));
      if (!inScope(row.from_leader_user_id, row.to_leader_user_id)) {
        throw new AuthError(403, "Neither end of that transfer is in your scope");
      }
      if (!inScope(next.from_leader_user_id, next.to_leader_user_id)) {
        throw new AuthError(403, "Neither end of the corrected transfer would be in your scope");
      }

      // A named account belongs to the leader on its side — checked where that side changed.
      const tree = await txn
        .select({ id: entities.entity_id, parent: entities.parent_entity_id })
        .from(entities);
      const ownedBy = (companies: number[], entityId: number) =>
        companies.includes(entityId) ||
        tree.some((e) => e.id === entityId && e.parent !== null && companies.includes(e.parent));
      const labels = await txn
        .select({
          id: bankAccounts.account_id,
          entity_id: bankAccounts.entity_id,
          label: bankAccounts.label,
        })
        .from(bankAccounts);
      const accountById = new Map(labels.map((a) => [a.id, a]));
      // A CS desk may name any leader in the house, but only its own company's
      // accounts — the ones it can see and answer for.
      const accountScope = user.role === "cs_agent" ? await transferEntityIds(user) : null;
      for (const [side, changed, accountId, personId] of [
        ["Sending", fromSideChanged, next.from_account_id, next.from_leader_user_id],
        ["Receiving", toSideChanged, next.to_account_id, next.to_leader_user_id],
      ] as const) {
        if (!changed || accountId == null) continue;
        const account = accountById.get(accountId);
        if (!account) throw new AuthError(404, `${side} bank account not found`);
        if (accountScope !== null && !accountScope.includes(account.entity_id)) {
          throw new AuthError(403, `${side} bank account is outside your company — record that end as Cash`);
        }
        if (!ownedBy(companiesOf(personId), account.entity_id)) {
          throw new AuthError(
            400,
            `${side} bank account does not belong to a company ` +
              `${personById.get(personId)?.full_name ?? "that leader"} holds`,
          );
        }
      }

      /**
       * Re-book: take the old movements off, put the new ones on, netted per
       * account so only the difference touches a balance. Applied in account id
       * order, so two edits locking the same pair of accounts queue rather than
       * deadlock.
       */
      const net = new Map<number, number>();
      const add = (id: number | null, delta: number) => {
        if (id == null) return;
        net.set(id, (net.get(id) ?? 0) + delta);
      };
      add(row.from_account_id, row.amount);
      add(row.to_account_id, -row.amount);
      add(next.from_account_id, -next.amount);
      add(next.to_account_id, next.amount);
      const balances: { account_id: number; delta: number; balance_after: number }[] = [];
      for (const [accountId, raw] of [...net.entries()].sort((a, b) => a[0] - b[0])) {
        const delta = +raw.toFixed(2);
        if (delta === 0) continue;
        balances.push({
          account_id: accountId,
          delta,
          balance_after: await moveBankBalance(txn, { accountId, delta }),
        });
      }

      const [saved] = await txn
        .update(leaderTransfers)
        .set(next)
        .where(eq(leaderTransfers.transfer_id, transferId))
        .returning();

      const shape = (r: typeof row) => ({
        from_leader_user_id: r.from_leader_user_id,
        to_leader_user_id: r.to_leader_user_id,
        amount: r.amount,
        from_account_id: r.from_account_id,
        from_cash: r.from_cash,
        from_bank_transfer: r.from_bank_transfer,
        to_account_id: r.to_account_id,
        to_cash: r.to_cash,
        to_bank_transfer: r.to_bank_transfer,
        note: r.note,
        created_at: r.created_at,
      });
      const changes = diffFields(shape(row), shape(saved));
      const nameOf = (id: number) => personById.get(id)?.full_name ?? `#${id}`;
      const endOf = (accountId: number | null, cash: boolean, bank = false) =>
        cash
          ? "cash"
          : bank
            ? "bank transfer"
            : accountId == null
            ? null
            : (accountById.get(accountId)?.label ?? `#${accountId}`);

      if (changes.length) {
        // amount = how much the settlement's figure moved; 0 for a note or a date.
        await txn.insert(transactions).values({
          entity_id: from?.entity_id ?? null,
          type: "leader_transfer",
          amount: +(saved.amount - row.amount).toFixed(2),
          reference_id: saved.transfer_id,
          user_id: user.user_id,
          details: {
            action: "leader_transfer_edited",
            from_leader: nameOf(saved.from_leader_user_id),
            to_leader: nameOf(saved.to_leader_user_id),
            from: endOf(saved.from_account_id, saved.from_cash, saved.from_bank_transfer),
            to: endOf(saved.to_account_id, saved.to_cash, saved.to_bank_transfer),
            amount: saved.amount,
            note: saved.note,
            changes,
            balances,
          },
        });
      }
      return { row, saved, changes, nameOf, balances };
    });

    if (result.changes.length) {
      await logActivity({
        category: "entity",
        action: "leader_transfer.edited",
        summary:
          `Leader transfer ${transferId} edited (${result.nameOf(result.saved.from_leader_user_id)} → ` +
          `${result.nameOf(result.saved.to_leader_user_id)}) — ${describeChanges(result.changes)}`,
        actor: user,
        targetType: "leader_transfer",
        targetId: transferId,
        changes: result.changes,
        context: { balances: result.balances },
      });
    }

    return Response.json({ leader_transfer: result.saved });
  } catch (e) {
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/**
 * DELETE /api/leader-transfers/:id — remove a settlement keyed wrong, and put
 * the banks back where they were.
 *
 * A settlement moved two balances when it was saved: the sending account down
 * and the receiving account up. Deleting the row without undoing those would
 * leave both banks wrong by the amount — the same reason the deposit and
 * withdrawal deletes unwind their bookings. Cash ends moved nothing and so
 * need nothing.
 *
 * Whoever recorded it may remove it, and an admin may remove any. A leader
 * settling with another is a private arrangement between them; the person who
 * typed it is the one who knows it was wrong.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const transferId = Number((await params).id);

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(leaderTransfers)
        .where(eq(leaderTransfers.transfer_id, transferId))
        .for("update");
      if (!row) throw new AuthError(404, "Leader transfer not found");

      // One end has to be yours, exactly as creating one requires.
      const [from] = await txn
        .select({ full_name: users.full_name, entity_id: users.entity_id })
        .from(users)
        .where(eq(users.user_id, row.from_leader_user_id));
      const [to] = await txn
        .select({ full_name: users.full_name, entity_id: users.entity_id })
        .from(users)
        .where(eq(users.user_id, row.to_leader_user_id));
      const visible = await leaderTransferEntityIds(user);
      if (
        visible !== null &&
        ![from?.entity_id, to?.entity_id].some((id) => id != null && visible.includes(id))
      ) {
        throw new AuthError(403, "Neither end of that transfer is in your scope");
      }
      if (user.role !== "super_admin" && row.created_by_user_id !== user.user_id) {
        throw new AuthError(
          403,
          "Only the person who recorded it, or an admin, can remove it",
        );
      }

      // Put the money back: the sender is refunded, the receiver gives it up.
      const balances: Record<string, number> = {};
      if (row.from_account_id != null) {
        balances.from_balance_after = await moveBankBalance(txn, {
          accountId: row.from_account_id,
          delta: row.amount,
        });
      }
      if (row.to_account_id != null) {
        balances.to_balance_after = await moveBankBalance(txn, {
          accountId: row.to_account_id,
          delta: -row.amount,
        });
      }

      const labels = await txn
        .select({ id: bankAccounts.account_id, label: bankAccounts.label })
        .from(bankAccounts);
      const labelOf = (id: number | null) =>
        id == null ? null : (labels.find((l) => l.id === id)?.label ?? `#${id}`);

      await txn.insert(transactions).values({
        entity_id: from?.entity_id ?? null,
        type: "leader_transfer",
        amount: -row.amount,
        reference_id: row.transfer_id,
        user_id: user.user_id,
        details: {
          action: "leader_transfer_deleted",
          from_leader: from?.full_name ?? null,
          to_leader: to?.full_name ?? null,
          from: row.from_cash
            ? "cash"
            : row.from_bank_transfer
              ? "bank transfer"
              : labelOf(row.from_account_id),
          to: row.to_cash
            ? "cash"
            : row.to_bank_transfer
              ? "bank transfer"
              : labelOf(row.to_account_id),
          amount: row.amount,
          note: row.note,
          ...balances,
        },
      });

      await txn.delete(leaderTransfers).where(eq(leaderTransfers.transfer_id, transferId));
      return { row, from, to };
    });

    await logActivity({
      category: "entity",
      action: "leader_transfer.deleted",
      summary:
        `Leader transfer deleted: ${result.from?.full_name ?? "?"} → ` +
        `${result.to?.full_name ?? "?"}, RM ${result.row.amount.toFixed(2)}`,
      actor: user,
      targetType: "leader_transfer",
      targetId: result.row.transfer_id,
      context: { amount: result.row.amount, note: result.row.note },
    });

    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

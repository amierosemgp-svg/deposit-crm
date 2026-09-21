import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, leaderTransfers, transactions, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError, visibleEntityIds } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { InsufficientBankBalanceError, moveBankBalance } from "@/lib/bank-balance";

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
      const visible = await visibleEntityIds(user);
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
          from: row.from_cash ? "cash" : labelOf(row.from_account_id),
          to: row.to_cash ? "cash" : labelOf(row.to_account_id),
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

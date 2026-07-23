import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, bankTransfers, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/** POST /api/transfers/:id/reject — recipient declines; sender is refunded. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const transferId = Number(id);

    const result = await db.transaction(async (txn) => {
      const [t] = await txn
        .select()
        .from(bankTransfers)
        .where(eq(bankTransfers.transfer_id, transferId))
        .for("update");
      if (!t) throw new AuthError(404, "Transfer not found");
      if (t.status !== "pending_confirmation") {
        throw new AuthError(409, `Transfer is already ${t.status}`);
      }

      const [to] = await txn
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, t.to_account_id));
      if (
        user.ownedEntityIds !== null &&
        !user.ownedEntityIds.includes(to.entity_id)
      ) {
        throw new AuthError(403, "Only the recipient side can reject this transfer");
      }

      // Refund the sender
      const [from] = await txn
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, t.from_account_id))
        .for("update");
      await txn
        .update(bankAccounts)
        .set({ current_balance: +(from.current_balance + t.amount).toFixed(2) })
        .where(eq(bankAccounts.account_id, from.account_id));

      const [updated] = await txn
        .update(bankTransfers)
        .set({
          status: "rejected",
          confirmed_by_user_id: user.user_id,
          confirmed_at: new Date().toISOString(),
        })
        .where(eq(bankTransfers.transfer_id, transferId))
        .returning();

      await txn.insert(transactions).values({
        entity_id: from.entity_id,
        type: "bank_transfer",
        amount: t.amount,
        reference_id: t.transfer_id,
        user_id: user.user_id,
        details: { action: "rejected", refunded_to: from.account_number },
      });

      return updated;
    });

    return Response.json({ transfer: result });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

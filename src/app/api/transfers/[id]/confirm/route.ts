import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, bankTransfers, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/** POST /api/transfers/:id/confirm — recipient side confirms receipt; credits the account. */
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
        .where(eq(bankAccounts.account_id, t.to_account_id))
        .for("update");

      // Only someone managing the recipient entity may confirm
      if (
        user.ownedEntityIds !== null &&
        !user.ownedEntityIds.includes(to.entity_id)
      ) {
        throw new AuthError(403, "Only the recipient side can confirm this transfer");
      }

      const nowIso = new Date().toISOString();
      await txn
        .update(bankAccounts)
        .set({ current_balance: +(to.current_balance + t.amount).toFixed(2) })
        .where(eq(bankAccounts.account_id, to.account_id));

      const [updated] = await txn
        .update(bankTransfers)
        .set({
          status: "confirmed",
          confirmed_by_user_id: user.user_id,
          confirmed_at: nowIso,
        })
        .where(eq(bankTransfers.transfer_id, transferId))
        .returning();

      await txn.insert(transactions).values({
        type: "bank_transfer",
        amount: t.amount,
        reference_id: t.transfer_id,
        user_id: user.user_id,
        details: { action: "confirmed" },
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

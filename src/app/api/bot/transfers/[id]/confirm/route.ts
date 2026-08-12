import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, bankTransfers, transactions } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { BotError, botErrorResponse, bankTransferJson, jsonError } from "@/lib/bot-crud";

/**
 * POST /api/bot/transfers/:id/confirm — confirms receipt and credits the
 * recipient account. Agent acts system-wide, so no recipient-ownership check.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const transferId = Number(id);

  try {
    const result = await db.transaction(async (txn) => {
      const [t] = await txn
        .select()
        .from(bankTransfers)
        .where(eq(bankTransfers.transfer_id, transferId))
        .for("update");
      if (!t) throw new BotError(404, "Transfer not found");
      if (t.status !== "pending_confirmation") {
        throw new BotError(409, `Transfer is already ${t.status}`);
      }

      const [to] = await txn
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, t.to_account_id))
        .for("update");

      const nowIso = new Date().toISOString();
      await txn
        .update(bankAccounts)
        .set({ current_balance: +(to.current_balance + t.amount).toFixed(2) })
        .where(eq(bankAccounts.account_id, to.account_id));

      const [updated] = await txn
        .update(bankTransfers)
        .set({ status: "confirmed", confirmed_at: nowIso })
        .where(eq(bankTransfers.transfer_id, transferId))
        .returning();

      await txn.insert(transactions).values({
        entity_id: to.entity_id,
        type: "bank_transfer",
        amount: t.amount,
        reference_id: t.transfer_id,
        details: { action: "confirmed", source: "bot" },
      });

      return updated;
    });

    return Response.json({ transfer: bankTransferJson(result) });
  } catch (e) {
    return botErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

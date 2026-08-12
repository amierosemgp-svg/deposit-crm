import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deposits, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * POST /api/deposits/:id/reject — reject a manual (skip-agent) deposit.
 * Marks it failed. No money has been booked yet (crediting only happens on
 * completion), so there is nothing to reverse. A failed deposit can still be
 * reprocessed.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const depositId = Number(id);

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(deposits)
        .where(eq(deposits.deposit_id, depositId))
        .for("update");
      if (!row) throw new AuthError(404, "Deposit not found");
      if (
        user.companyIds !== null &&
        row.company_entity_id !== null &&
        !user.companyIds.includes(row.company_entity_id)
      ) {
        throw new AuthError(403, "Deposit is outside your company scope");
      }
      if (!row.skip_bot) {
        throw new AuthError(422, "Only manual (skip-agent) deposits are rejected here");
      }
      if (!["pending", "matched", "processing"].includes(row.status)) {
        throw new AuthError(409, `Deposit is "${row.status}", cannot reject`);
      }

      const nowIso = new Date().toISOString();
      const [updated] = await txn
        .update(deposits)
        .set({ status: "failed", handled_by_user_id: user.user_id, updated_at: nowIso })
        .where(eq(deposits.deposit_id, depositId))
        .returning();

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: row.company_entity_id,
        type: "deposit",
        amount: row.deposit_amount,
        game_name: row.selected_game,
        reference_id: row.deposit_id,
        user_id: user.user_id,
        details: { source: "manual", action: "rejected", from: row.status },
      });

      return updated;
    });

    return Response.json({ deposit: result });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deposits, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * POST /api/deposits/:id/approve — Approve & dispatch to the agent.
 * Sets the deposit to "processing" and hands it to the agent. No money moves
 * here: the player's game balance, the company BO pool, and total_deposits are
 * only booked when the agent confirms the real top-up succeeded (its
 * PATCH /api/bot/transactions/:id/status → "completed" call). That keeps a
 * failed top-up clean — nothing to reverse — and lets CS reprocess it.
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
      if (!["pending", "matched"].includes(row.status)) {
        throw new AuthError(409, `Deposit is "${row.status}", expected pending/matched`);
      }
      if (!row.player_id) {
        throw new AuthError(422, "Assign a player before approving");
      }
      if (!row.selected_game) {
        throw new AuthError(422, "Select a game before approving");
      }

      const nowIso = new Date().toISOString();
      const [updated] = await txn
        .update(deposits)
        .set({
          status: "processing",
          handled_by_user_id: user.user_id,
          updated_at: nowIso,
        })
        .where(eq(deposits.deposit_id, depositId))
        .returning();

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: row.company_entity_id,
        type: "deposit",
        amount: row.total_amount,
        game_name: row.selected_game,
        reference_id: row.deposit_id,
        user_id: user.user_id,
        details: {
          action: "approved_dispatched",
          bonus_percentage: row.bonus_percentage,
        },
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

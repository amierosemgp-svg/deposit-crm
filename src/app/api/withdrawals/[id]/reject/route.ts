import { eq } from "drizzle-orm";
import { db } from "@/db";
import { players, transactions, withdrawals } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * POST /api/withdrawals/:id/reject — decline a withdrawal request.
 * Only allowed while still "requested" (no credits pulled yet), so there is
 * nothing to reverse. Marks it failed.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const withdrawalId = Number(id);

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .for("update");
      if (!row) throw new AuthError(404, "Withdrawal not found");
      if (row.status !== "requested") {
        throw new AuthError(
          409,
          `Withdrawal is "${row.status}"; only a requested one can be rejected`,
        );
      }

      const [player] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, row.player_id));
      if (
        user.companyIds !== null &&
        !user.companyIds.includes(player.company_entity_id)
      ) {
        throw new AuthError(403, "Withdrawal is outside your company scope");
      }

      const nowIso = new Date().toISOString();
      const [updated] = await txn
        .update(withdrawals)
        .set({
          status: "failed",
          handled_by_user_id: user.user_id,
          updated_at: nowIso,
        })
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .returning();

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: player.company_entity_id,
        type: "withdrawal",
        amount: row.requested_amount,
        game_name: row.game_name,
        reference_id: row.withdrawal_id,
        user_id: user.user_id,
        details: { source: "manual", action: "rejected" },
      });

      return updated;
    });

    return Response.json({ withdrawal: result });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

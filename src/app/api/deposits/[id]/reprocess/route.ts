import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deposits, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * POST /api/deposits/:id/reprocess — recover a failed deposit.
 * Moves a "failed" deposit back to "pending" so CS can review (adjust game,
 * bonus, or the player's game account) and re-approve it. No money moves —
 * a failed deposit was never credited (crediting only happens when the agent
 * confirms "completed"), so there is nothing to reverse.
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
      if (row.status !== "failed") {
        throw new AuthError(409, `Only failed deposits can be reprocessed (this one is "${row.status}")`);
      }

      const nowIso = new Date().toISOString();
      const [updated] = await txn
        .update(deposits)
        .set({
          status: "pending",
          game_topup_reference: null,
          // It is genuinely waiting on a human again, so the old approval no
          // longer describes it. Re-approving stamps a fresh one; leaving the
          // stale time would make the queue-time figures nonsense.
          approved_at: null,
          updated_at: nowIso,
        })
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
        details: { action: "reprocess", from: "failed", to: "pending" },
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

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deposits } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { completeManualDeposit } from "@/lib/deposit-complete";
import { InsufficientKioskCreditError } from "@/lib/kiosk-credit";

/**
 * POST /api/deposits/:id/complete — manual completion of a skip-agent deposit.
 * The CS agent has already done the game top-up in the provider back-office;
 * this books the ledger exactly like the agent's completed transition (credits
 * the player's game balance, deducts the company BO pool when one exists, and
 * bumps total_deposits) and marks the deposit completed. Only skip-agent deposits
 * in "processing" qualify — normal deposits are completed by the agent.
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
        throw new AuthError(422, "Only manual (skip-agent) deposits are completed here");
      }
      if (row.status !== "processing") {
        throw new AuthError(409, `Deposit is "${row.status}", approve it first`);
      }
      if (!row.player_id || !row.selected_game) {
        throw new AuthError(422, "A player and game are required to complete");
      }

      return completeManualDeposit(txn, { row, userId: user.user_id });
    });

    return Response.json({ deposit: result });
  } catch (e) {
    if (e instanceof InsufficientKioskCreditError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

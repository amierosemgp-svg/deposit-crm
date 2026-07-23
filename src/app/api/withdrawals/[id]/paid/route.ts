import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  bankAccounts,
  players,
  transactions,
  withdrawals,
} from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const paidSchema = z.object({
  paid_from_account_id: z.number().int().positive().optional(),
  proof_url: z.string().url().optional(),
});

/**
 * POST /api/withdrawals/:id/paid — CS confirms the manual bank payout.
 * Optionally deducts the payout from a withdrawal-role company account.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const withdrawalId = Number(id);
    const parsed = paidSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .for("update");
      if (!row) throw new AuthError(404, "Withdrawal not found");
      if (row.status !== "credits_pulled") {
        throw new AuthError(
          409,
          `Withdrawal is "${row.status}", pull credits first`,
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

      if (body.paid_from_account_id) {
        const [account] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, body.paid_from_account_id))
          .for("update");
        if (!account) throw new AuthError(404, "Payout account not found");
        if (account.role !== "withdrawal") {
          throw new AuthError(422, "Payouts must come from a withdrawal-role account");
        }
        if (account.current_balance < row.credit_pulled_amount) {
          throw new AuthError(422, "Insufficient balance in payout account");
        }
        await txn
          .update(bankAccounts)
          .set({
            current_balance: +(
              account.current_balance - row.credit_pulled_amount
            ).toFixed(2),
          })
          .where(eq(bankAccounts.account_id, account.account_id));
      }

      const nowIso = new Date().toISOString();
      const [updated] = await txn
        .update(withdrawals)
        .set({
          status: "paid",
          paid_from_account_id: body.paid_from_account_id,
          proof_url: body.proof_url,
          paid_at: nowIso,
          updated_at: nowIso,
        })
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .returning();

      await txn
        .update(players)
        .set({
          total_withdrawals: sql`${players.total_withdrawals} + ${row.credit_pulled_amount}`,
        })
        .where(eq(players.player_id, row.player_id));

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: player.company_entity_id,
        type: "withdrawal",
        amount: row.credit_pulled_amount,
        game_name: row.game_name,
        reference_id: row.withdrawal_id,
        user_id: user.user_id,
        details: {
          action: "paid",
          paid_from_account_id: body.paid_from_account_id ?? null,
        },
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

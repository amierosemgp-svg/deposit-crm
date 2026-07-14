import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  deposits,
  gameCredits,
  players,
  providerBoAccounts,
  transactions,
} from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * POST /api/deposits/:id/approve — Approve & Top-Up.
 * Atomically: deposit → completed, player game balance += total,
 * company BO credit pool -= total (when a pool exists), audit logged.
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
      const reference = `TOPUP-${Math.floor(Math.random() * 900000 + 100000)}`;

      // Deduct from the company's BO credit pool when one exists for this game
      if (row.company_entity_id) {
        const [bo] = await txn
          .select()
          .from(providerBoAccounts)
          .where(
            and(
              eq(providerBoAccounts.company_entity_id, row.company_entity_id),
              eq(providerBoAccounts.game_name, row.selected_game),
              eq(providerBoAccounts.status, "active"),
            ),
          )
          .for("update");
        if (bo) {
          if (bo.current_credit < row.total_amount) {
            throw new AuthError(
              422,
              `Insufficient BO credit for ${row.selected_game} (${bo.current_credit.toFixed(2)} available, ${row.total_amount.toFixed(2)} needed)`,
            );
          }
          await txn
            .update(providerBoAccounts)
            .set({
              current_credit: +(bo.current_credit - row.total_amount).toFixed(2),
            })
            .where(eq(providerBoAccounts.bo_account_id, bo.bo_account_id));
        }
      }

      // Upsert player's game balance
      await txn
        .insert(gameCredits)
        .values({
          player_id: row.player_id,
          game_name: row.selected_game,
          current_balance: row.total_amount,
          last_updated_at: nowIso,
        })
        .onConflictDoUpdate({
          target: [gameCredits.player_id, gameCredits.game_name],
          set: {
            current_balance: sql`${gameCredits.current_balance} + ${row.total_amount}`,
            last_updated_at: nowIso,
          },
        });

      await txn
        .update(players)
        .set({
          total_deposits: sql`${players.total_deposits} + ${row.deposit_amount}`,
        })
        .where(eq(players.player_id, row.player_id));

      const [updated] = await txn
        .update(deposits)
        .set({
          status: "completed",
          handled_by_user_id: user.user_id,
          game_topup_reference: reference,
          updated_at: nowIso,
        })
        .where(eq(deposits.deposit_id, depositId))
        .returning();

      await txn.insert(transactions).values({
        player_id: row.player_id,
        type: "game_topup",
        amount: row.total_amount,
        game_name: row.selected_game,
        reference_id: row.deposit_id,
        user_id: user.user_id,
        details: {
          bonus_percentage: row.bonus_percentage,
          topup_reference: reference,
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

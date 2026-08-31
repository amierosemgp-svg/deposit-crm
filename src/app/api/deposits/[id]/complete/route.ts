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
import { maybeCreateReferralBonus } from "@/lib/referral";
import { balanceSyncedSince, canonicalise } from "@/lib/game-name";
import { CREDIT_CONFLICT_TARGET, resolveGameLogin } from "@/lib/game-credits";

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

      const nowIso = new Date().toISOString();

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

      // Same two rules as the agent's completion path: one canonical spelling
      // per game, and never add a delta on top of a balance the agent has
      // already read off the provider.
      const gameName = await canonicalise(row.selected_game, txn);
      const [pl] = await txn
        .select({ game_accounts: players.game_accounts })
        .from(players)
        .where(eq(players.player_id, row.player_id));
      const gameUsername = resolveGameLogin(
        pl?.game_accounts ?? null,
        gameName,
        row.selected_game_username,
      );
      const alreadySynced = await balanceSyncedSince(txn, {
        playerId: row.player_id,
        gameName,
        gameUsername,
        sinceIso: row.approved_at ?? row.updated_at ?? row.created_at,
      });

      if (!alreadySynced) {
        await txn
          .insert(gameCredits)
          .values({
            player_id: row.player_id,
            game_name: gameName,
            game_username: gameUsername,
            current_balance: row.total_amount,
            last_updated_at: nowIso,
          })
          .onConflictDoUpdate({
            target: [...CREDIT_CONFLICT_TARGET],
            set: {
              current_balance: sql`${gameCredits.current_balance} + ${row.total_amount}`,
              last_updated_at: nowIso,
            },
          });
      }

      await txn
        .update(players)
        .set({
          total_deposits: sql`${players.total_deposits} + ${row.deposit_amount}`,
        })
        .where(eq(players.player_id, row.player_id));

      const [updated] = await txn
        .update(deposits)
        .set({ status: "completed", handled_by_user_id: user.user_id, updated_at: nowIso })
        .where(eq(deposits.deposit_id, depositId))
        .returning();

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: row.company_entity_id,
        type: "game_topup",
        amount: row.total_amount,
        game_name: gameName,
        reference_id: row.deposit_id,
        user_id: user.user_id,
        details: {
          source: "manual",
          game_username: gameUsername,
          action: "manual_complete",
          ...(alreadySynced
            ? {
                balance_credited: false,
                reason: "agent had already synced the provider balance",
                synced_at: alreadySynced.created_at,
                synced_balance: alreadySynced.balance_after,
              }
            : { balance_credited: true }),
        },
      });

      // Inside the same transaction, so a bonus can't survive a rollback.
      await maybeCreateReferralBonus(txn, row.deposit_id);

      return updated;
    });

    return Response.json({ deposit: result });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

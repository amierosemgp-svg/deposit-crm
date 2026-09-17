import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { deposits, gameCredits, players, transactions } from "@/db/schema";
import { balanceSyncedSince, canonicalise } from "@/lib/game-name";
import { CREDIT_CONFLICT_TARGET, resolveGameLogin } from "@/lib/game-credits";
import { moveKioskCredit } from "@/lib/kiosk-credit";
import { maybeCreateReferralBonus } from "@/lib/referral";

type Txn = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DepositRow = typeof deposits.$inferSelect;

/**
 * Book a manual deposit as done: the player's game balance up, the company's
 * kiosk float down, total_deposits up, the row marked completed.
 *
 * Lifted out of POST /api/deposits/:id/complete so that saving a manual row
 * and completing one later run the same booking. They used to be the same
 * steps written once; the moment the sheet could complete on save, two copies
 * would have meant two ways for the ledger to end up.
 *
 * The caller owns the transaction and must have locked `row` if it wasn't
 * created inside it. Throws InsufficientKioskCreditError when the float can't
 * cover the top-up — the one failure a caller may reasonably want to absorb.
 */
export async function completeManualDeposit(
  txn: Txn,
  input: { row: DepositRow; userId: number; nowIso?: string },
): Promise<DepositRow> {
  const { row, userId } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (!row.player_id || !row.selected_game) {
    throw new Error("completeManualDeposit needs a player and a game");
  }

  // The float pays for the top-up. Silently skipped when the company keeps no
  // kiosk row for the game — see moveKioskCredit.
  await moveKioskCredit(txn, {
    companyEntityId: row.company_entity_id,
    gameName: row.selected_game,
    delta: -row.total_amount,
  });

  // Same two rules as the agent's completion path: one canonical spelling per
  // game, and never add a delta on top of a balance the agent has already read
  // off the provider.
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
    .set({ total_deposits: sql`${players.total_deposits} + ${row.deposit_amount}` })
    .where(eq(players.player_id, row.player_id));

  const [updated] = await txn
    .update(deposits)
    .set({ status: "completed", handled_by_user_id: userId, updated_at: nowIso })
    .where(eq(deposits.deposit_id, row.deposit_id))
    .returning();

  await txn.insert(transactions).values({
    player_id: row.player_id,
    entity_id: row.company_entity_id,
    type: "game_topup",
    amount: row.total_amount,
    game_name: gameName,
    reference_id: row.deposit_id,
    user_id: userId,
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
}

import { desc, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  bankAccounts,
  bankTransfers,
  deposits,
  gameCredits,
  gameTransfers,
  players,
  providerBoAccounts,
  providerBoAdjustments,
  settings,
  transactions,
  users,
  withdrawals,
} from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import {
  autoConfirmExpiredTransfers,
  depositScopeFilter,
  visibleEntityIds,
  visibleEntityTree,
} from "@/lib/api-helpers";

/**
 * GET /api/state — the CRM's single scoped hydration endpoint.
 * Returns every collection the UI needs, filtered by the user's role scope.
 * The frontend polls this (10s) for live updates.
 */
export async function GET() {
  try {
    const user = await requireUser();

    // Lazy sweep: settle any transfer whose confirmation window expired
    await autoConfirmExpiredTransfers();

    const entityTree = await visibleEntityTree(user);
    const entityIds = await visibleEntityIds(user);
    const companyIds =
      user.companyIds ??
      entityTree.filter((e) => e.entity_type === "company").map((e) => e.entity_id);

    const scopedPlayers = await (companyIds.length || user.companyIds === null
      ? db
          .select()
          .from(players)
          .where(
            user.companyIds === null
              ? undefined
              : inArray(players.company_entity_id, companyIds),
          )
      : Promise.resolve([]));
    const playerIds = scopedPlayers.map((p) => p.player_id);

    const accountEntityIds =
      entityIds ?? entityTree.map((e) => e.entity_id);
    const scopedAccounts = await db
      .select()
      .from(bankAccounts)
      .where(
        user.companyIds === null
          ? undefined
          : inArray(bankAccounts.entity_id, accountEntityIds),
      );
    const accountIds = scopedAccounts.map((a) => a.account_id);

    const [
      scopedDeposits,
      scopedWithdrawals,
      scopedCredits,
      scopedGameTransfers,
      scopedBankTransfers,
      scopedBoAccounts,
      allUsers,
      allSettings,
      auditLog,
    ] = await Promise.all([
      db
        .select()
        .from(deposits)
        .where(depositScopeFilter(user))
        .orderBy(desc(deposits.created_at))
        .limit(500),
      playerIds.length
        ? db
            .select()
            .from(withdrawals)
            .where(inArray(withdrawals.player_id, playerIds))
            .orderBy(desc(withdrawals.created_at))
            .limit(500)
        : user.companyIds === null
          ? db.select().from(withdrawals).orderBy(desc(withdrawals.created_at)).limit(500)
          : Promise.resolve([]),
      playerIds.length
        ? db.select().from(gameCredits).where(inArray(gameCredits.player_id, playerIds))
        : user.companyIds === null
          ? db.select().from(gameCredits)
          : Promise.resolve([]),
      playerIds.length
        ? db
            .select()
            .from(gameTransfers)
            .where(inArray(gameTransfers.player_id, playerIds))
            .orderBy(desc(gameTransfers.created_at))
            .limit(200)
        : user.companyIds === null
          ? db.select().from(gameTransfers).orderBy(desc(gameTransfers.created_at)).limit(200)
          : Promise.resolve([]),
      accountIds.length
        ? db
            .select()
            .from(bankTransfers)
            .where(
              user.companyIds === null
                ? undefined
                : inArray(bankTransfers.from_account_id, accountIds),
            )
            .orderBy(desc(bankTransfers.created_at))
            .limit(200)
        : user.companyIds === null
          ? db.select().from(bankTransfers).orderBy(desc(bankTransfers.created_at)).limit(200)
          : Promise.resolve([]),
      db
        .select()
        .from(providerBoAccounts)
        .where(
          user.companyIds === null
            ? undefined
            : inArray(providerBoAccounts.company_entity_id, companyIds.length ? companyIds : [-1]),
        ),
      db
        .select({
          user_id: users.user_id,
          username: users.username,
          full_name: users.full_name,
          role: users.role,
          entity_id: users.entity_id,
          status: users.status,
          last_login_at: users.last_login_at,
          created_at: users.created_at,
        })
        .from(users)
        .where(
          user.companyIds === null
            ? undefined
            : inArray(
                users.entity_id,
                entityTree.map((e) => e.entity_id),
              ),
        ),
      db.select().from(settings),
      db
        .select()
        .from(transactions)
        .orderBy(desc(transactions.created_at))
        .limit(500),
    ]);

    // Include transfers *into* my accounts that originate elsewhere (pending inbox)
    const inboundIds = accountIds.length
      ? await db
          .select()
          .from(bankTransfers)
          .where(inArray(bankTransfers.to_account_id, accountIds))
          .orderBy(desc(bankTransfers.created_at))
          .limit(200)
      : [];
    const transferMap = new Map(
      [...scopedBankTransfers, ...inboundIds].map((t) => [t.transfer_id, t]),
    );

    const boIds = scopedBoAccounts.map((b) => b.bo_account_id);
    const scopedAdjustments = boIds.length
      ? await db
          .select()
          .from(providerBoAdjustments)
          .where(inArray(providerBoAdjustments.bo_account_id, boIds))
          .orderBy(desc(providerBoAdjustments.created_at))
          .limit(200)
      : [];

    return Response.json({
      me: user,
      entities: entityTree,
      users: allUsers,
      players: scopedPlayers,
      deposits: scopedDeposits,
      withdrawals: scopedWithdrawals,
      gameCredits: scopedCredits,
      gameTransfers: scopedGameTransfers,
      bankAccounts: scopedAccounts,
      bankTransfers: [...transferMap.values()].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
      boAccounts: scopedBoAccounts,
      boAdjustments: scopedAdjustments,
      auditLog,
      settings: Object.fromEntries(allSettings.map((s) => [s.key, s.value])),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error("GET /api/state failed:", e);
    return Response.json({ error: "Server error" }, { status: 500 });
  }
}

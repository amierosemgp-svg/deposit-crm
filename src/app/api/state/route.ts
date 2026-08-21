import { asc, desc, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  bankAccounts,
  bankTransfers,
  bonusPlans,
  botCommands,
  botHealth,
  deposits,
  expenses,
  gameCredits,
  gameTransfers,
  players,
  providerBoAccounts,
  providerBoAdjustments,
  settings,
  users,
  withdrawals,
} from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import {
  autoConfirmExpiredTransfers,
  depositScopeFilter,
  retryStuckGameTransfers,
  visibleEntityIds,
  visibleEntityTree,
} from "@/lib/api-helpers";
import { poolStock } from "@/lib/game-account-pool";
import { expireStaleBotCommands } from "@/lib/bot-commands";

/**
 * GET /api/state — the CRM's single scoped hydration endpoint.
 * Returns every collection the UI needs, filtered by the user's role scope.
 * The frontend polls this (10s) for live updates.
 */
export async function GET() {
  try {
    const user = await requireUser();

    // Lazy sweeps, on the 10s poll: settle any bank transfer whose confirmation
    // window expired, and restart any game transfer the agent has gone quiet on.
    await autoConfirmExpiredTransfers();
    await retryStuckGameTransfers();
    // …and settle any on-demand agent command nobody picked up or finished, so
    // a crawl requested while the agent was down never fires hours late.
    await expireStaleBotCommands();

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
          // Without an explicit order Postgres returns heap order, and an
          // UPDATE writes a new tuple at the end of the heap — so editing a
          // player made them jump position in the list. player_id breaks ties
          // because a bulk import gives every row the same registration_date.
          .orderBy(desc(players.registration_date), desc(players.player_id))
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
        )
        .orderBy(asc(users.user_id)),
      db.select().from(settings),
    ]);

    // The bonus catalogue: everyone sees the house-wide plans, plus any pinned
    // to a company they can see. Inactive ones come too — the admin screen
    // needs them, and the deposits dropdown filters them out itself.
    const scopedBonusPlans = await db
      .select()
      .from(bonusPlans)
      .where(
        user.companyIds === null
          ? undefined
          : or(
              isNull(bonusPlans.company_entity_id),
              inArray(
                bonusPlans.company_entity_id,
                companyIds.length ? companyIds : [-1],
              ),
            ),
      )
      .orderBy(asc(bonusPlans.type), asc(bonusPlans.name));

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

    // Agent process health — system-wide, shown to any authed user.
    const bots = await db
      .select()
      .from(botHealth)
      .orderBy(desc(botHealth.last_heartbeat_at));

    // On-demand commands (the Crawl banks button). Only the recent tail: the UI
    // needs the one in flight and the last outcome, not the history. Unscoped
    // commands crawl every bank, this user's included, so they come too.
    const scopedCommands = await db
      .select()
      .from(botCommands)
      .where(
        user.companyIds === null
          ? undefined
          : or(
              isNull(botCommands.company_entity_id),
              inArray(
                botCommands.company_entity_id,
                companyIds.length ? companyIds : [-1],
              ),
            ),
      )
      .orderBy(desc(botCommands.command_id))
      .limit(20);

    // Operational expenses are admin-only.
    const scopedExpenses =
      user.role === "super_admin"
        ? await db
            .select()
            .from(expenses)
            .orderBy(desc(expenses.expense_date))
            .limit(500)
        : [];

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
      bonusPlans: scopedBonusPlans,
      expenses: scopedExpenses,
      botHealth: bots,
      botCommands: scopedCommands,
      // Counts only — how many pre-registered accounts are left per game, so
      // the UI can warn before the pool runs dry. The accounts themselves are
      // never shipped to the browser.
      gameAccountStock: await poolStock(),
      settings: Object.fromEntries(allSettings.map((s) => [s.key, s.value])),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error("GET /api/state failed:", e);
    return Response.json({ error: "Server error" }, { status: 500 });
  }
}

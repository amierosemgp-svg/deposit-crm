import { aliasedTable, and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
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
  referralBonuses,
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
 * How often the lazy sweeps below actually run, regardless of poll rate.
 *
 * They were firing on every single poll — three sweeps, four sequential
 * round trips, every 10 seconds, per open tab — which on an idle system found
 * nothing to do four times a minute per user. Everything they settle is
 * measured in minutes (a 5-minute transfer stall, a 10-minute command TTL), so
 * checking four times a minute was never buying anything over checking twice.
 *
 * Per-instance, not global: a warm serverless instance keeps this between
 * invocations, and several instances each sweeping once a period is still far
 * less work than every request sweeping. It is a throttle, not a lock — the
 * sweeps are all idempotent and safe to run concurrently.
 */
const SWEEP_INTERVAL_MS = 30_000;
let lastSweptAt = 0;

/**
 * GET /api/state — the CRM's single scoped hydration endpoint.
 * Returns every collection the UI needs, filtered by the user's role scope.
 * The frontend polls this (10s) for live updates.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();

    // The player list is 98% of this payload — 2,625 rows, 1.5 MB, and the UI
    // polls every 10 seconds. Re-sending an unchanged roster six times a minute
    // per open tab is what put the database 713% over its egress quota.
    //
    // So the client tells us the version it holds and we omit the list when it
    // is still current. `players.updated_at` is trigger-maintained, so this
    // cannot serve a stale roster as fresh: any write from any path moves it.
    // count(*) is in the version because a DELETE lowers no timestamp.
    const [playersStamp] = await db
      .select({
        max: sql<string | null>`max(${players.updated_at})`,
        count: sql<number>`count(*)::int`,
      })
      .from(players);
    // The viewer's own scope is part of the version: the stamp above only
    // answers "did the players table change", and a user moved to a different
    // company would otherwise keep serving themselves a roster they can no
    // longer see.
    const scopeKey =
      user.companyIds === null ? "all" : [...user.companyIds].sort().join(".");
    const playersVersion = `${playersStamp?.max ?? "0"}:${playersStamp?.count ?? 0}:${scopeKey}`;
    const playersUnchanged =
      new URL(request.url).searchParams.get("pv") === playersVersion;

    // Lazy sweeps: settle any bank transfer whose confirmation window expired,
    // restart any game transfer the agent has gone quiet on, and settle any
    // on-demand agent command nobody picked up — so a crawl requested while the
    // agent was down never fires hours late.
    //
    // In parallel and throttled: they are independent of each other and of
    // everything below, so making the caller wait for them one after another
    // was pure latency. The cron jobs in vercel.json run the first two anyway;
    // this is the "someone has the CRM open" path, not the guarantee.
    if (Date.now() - lastSweptAt >= SWEEP_INTERVAL_MS) {
      lastSweptAt = Date.now();
      await Promise.all([
        autoConfirmExpiredTransfers(),
        retryStuckGameTransfers(),
        expireStaleBotCommands(),
      ]);
    }

    const entityTree = await visibleEntityTree(user);
    const entityIds = await visibleEntityIds(user);
    const companyIds =
      user.companyIds ??
      entityTree.filter((e) => e.entity_type === "company").map((e) => e.entity_id);

    const canSeePlayers = companyIds.length > 0 || user.companyIds === null;
    const playerScope =
      user.companyIds === null
        ? undefined
        : inArray(players.company_entity_id, companyIds);

    // The ids are needed either way — they scope the withdrawals, credits,
    // transfers and bonuses below — but they never leave the server, so when
    // the client's roster is current we fetch the ids alone and skip the 1.5 MB.
    let scopedPlayers: (typeof players.$inferSelect)[] = [];
    let playerIds: number[] = [];
    if (canSeePlayers && playersUnchanged) {
      const idRows = await db
        .select({ player_id: players.player_id })
        .from(players)
        .where(playerScope);
      playerIds = idRows.map((p) => p.player_id);
    } else if (canSeePlayers) {
      scopedPlayers = await db
        .select()
        .from(players)
        .where(playerScope)
        // Without an explicit order Postgres returns heap order, and an
        // UPDATE writes a new tuple at the end of the heap — so editing a
        // player made them jump position in the list. player_id breaks ties
        // because a bulk import gives every row the same registration_date.
        .orderBy(desc(players.registration_date), desc(players.player_id));
      playerIds = scopedPlayers.map((p) => p.player_id);
    }

    // CS agents work a rolling day: transactions older than 24h are not
    // theirs to browse. Leaders and admins see the full window.
    const csCutoffIso =
      user.role === "cs_agent"
        ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        : null;

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
        .where(
          and(
            depositScopeFilter(user),
            csCutoffIso ? gte(deposits.created_at, csCutoffIso) : undefined,
          ),
        )
        .orderBy(desc(deposits.created_at))
        .limit(500),
      playerIds.length
        ? db
            .select()
            .from(withdrawals)
            .where(
              and(
                inArray(withdrawals.player_id, playerIds),
                csCutoffIso ? gte(withdrawals.created_at, csCutoffIso) : undefined,
              ),
            )
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
            .where(
              and(
                inArray(gameTransfers.player_id, playerIds),
                csCutoffIso ? gte(gameTransfers.created_at, csCutoffIso) : undefined,
              ),
            )
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
              and(
                user.companyIds === null
                  ? undefined
                  : inArray(bankTransfers.from_account_id, accountIds),
                csCutoffIso ? gte(bankTransfers.created_at, csCutoffIso) : undefined,
              ),
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

    // Everything below depends only on values already resolved above —
    // companyIds, accountIds, playerIds, boIds — and nothing here depends on
    // anything else here. They used to be seven `await`s in a row, which on a
    // Singapore→Mumbai link cost seven full round trips (~1.5s) to fetch data
    // the database could have been working on all at once.
    const boIds = scopedBoAccounts.map((b) => b.bo_account_id);
    const downlinePlayer = aliasedTable(players, "downline_player");

    const [
      scopedBonusPlans,
      inboundIds,
      bots,
      scopedCommands,
      scopedExpenses,
      scopedAdjustments,
      scopedReferralBonuses,
    ] = await Promise.all([
      // The bonus catalogue: everyone sees the house-wide plans, plus any
      // pinned to a company they can see. Inactive ones come too — the admin
      // screen needs them, and the deposits dropdown filters them out itself.
      db
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
        .orderBy(asc(bonusPlans.type), asc(bonusPlans.name)),

      // Transfers *into* my accounts that originate elsewhere (pending inbox).
      accountIds.length
        ? db
            .select()
            .from(bankTransfers)
            .where(inArray(bankTransfers.to_account_id, accountIds))
            .orderBy(desc(bankTransfers.created_at))
            .limit(200)
        : Promise.resolve([]),

      // Agent process health — system-wide, shown to any authed user.
      db.select().from(botHealth).orderBy(desc(botHealth.last_heartbeat_at)),

      // On-demand commands (the Crawl banks button). Only the recent tail: the
      // UI needs the one in flight and the last outcome, not the history.
      // Unscoped commands crawl every bank, this user's included, so they come
      // too.
      db
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
        .limit(20),

      // Operational expenses are admin-only.
      user.role === "super_admin"
        ? db
            .select()
            .from(expenses)
            .orderBy(desc(expenses.expense_date))
            .limit(500)
        : Promise.resolve([]),

      boIds.length
        ? db
            .select()
            .from(providerBoAdjustments)
            .where(inArray(providerBoAdjustments.bo_account_id, boIds))
            .orderBy(desc(providerBoAdjustments.created_at))
            .limit(200)
        : Promise.resolve([]),

      // Recommend (referral) bonuses, keyed on the *upline* — the player who
      // earns them. Scoped the same way the player list is, so a leader sees
      // exactly the bonuses belonging to players they can already see. The
      // downline's name is joined here rather than looked up in the browser
      // because the downline may sit outside the viewer's scope entirely.
      playerIds.length || user.companyIds === null
        ? db
            .select({
              bonus_id: referralBonuses.bonus_id,
              upline_player_id: referralBonuses.upline_player_id,
              downline_player_id: referralBonuses.downline_player_id,
              downline_username: downlinePlayer.username,
              downline_full_name: downlinePlayer.full_name,
              deposit_id: referralBonuses.deposit_id,
              deposit_amount: referralBonuses.deposit_amount,
              bonus_percentage: referralBonuses.bonus_percentage,
              bonus_amount: referralBonuses.bonus_amount,
              status: referralBonuses.status,
              game_name: referralBonuses.game_name,
              skip_bot: referralBonuses.skip_bot,
              game_transfer_id: referralBonuses.game_transfer_id,
              assigned_by_user_id: referralBonuses.assigned_by_user_id,
              assigned_at: referralBonuses.assigned_at,
              note: referralBonuses.note,
              created_at: referralBonuses.created_at,
            })
            .from(referralBonuses)
            .leftJoin(
              downlinePlayer,
              eq(referralBonuses.downline_player_id, downlinePlayer.player_id),
            )
            .where(
              user.companyIds === null
                ? undefined
                : inArray(referralBonuses.upline_player_id, playerIds),
            )
            .orderBy(desc(referralBonuses.bonus_id))
            .limit(500)
        : Promise.resolve([]),
    ]);

    const transferMap = new Map(
      [...scopedBankTransfers, ...inboundIds].map((t) => [t.transfer_id, t]),
    );

    return Response.json({
      me: user,
      entities: entityTree,
      users: allUsers,
      // Omitted, not nulled, when unchanged — the store shallow-merges, so an
      // absent key keeps the roster it already has.
      ...(playersUnchanged ? {} : { players: scopedPlayers }),
      playersVersion,
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
      referralBonuses: scopedReferralBonuses,
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

import { aliasedTable, and, asc, desc, eq, getTableColumns, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bankAccounts,
  bankTransfers,
  bonusPlans,
  botCommands,
  botHealth,
  companyLeaders,
  leaderMemberships,
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
export async function GET() {
  try {
    const user = await requireUser();

    /**
     * The roster is no longer sent here at all.
     *
     * It used to be the whole payload, and a version stamp kept it from being
     * re-sent while unchanged. That held up to a few hundred members. Importing
     * Pokercity's master list took it to 12,280 — 8 MB of JSON — and the stamp
     * stopped helping, because completing a deposit writes players.total_deposits
     * and the trigger moves updated_at: during a shift the roster changes every
     * minute or two, so almost every ten-second poll shipped all 8 MB again.
     *
     * Nothing ever needed the whole list. A sheet needs the members on the rows
     * it drew, a search box needs what matches the typing, and a hierarchy page
     * needs a count. Those are GET /api/players (paged, searchable, and
     * hydrate-by-id) and the counts below.
     */

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

    /**
     * Who currently runs each visible company. Small — one row per company per
     * leader — and the hierarchy cannot be drawn without it now that a company
     * may sit under more than one leader.
     */
    const ownership = entityTree.length
      ? await db
          .select()
          .from(companyLeaders)
          .where(
            and(
              isNull(companyLeaders.valid_to),
              inArray(
                companyLeaders.company_entity_id,
                entityTree.map((e) => e.entity_id),
              ),
            ),
          )
      : [];
    /**
     * Which leaders hold which extra companies.
     *
     * A handful of rows — one per grant beyond the company a leader was created
     * under — so the hierarchy can show a leader on every company they hold
     * without asking per user.
     */
    const memberships = entityTree.length
      ? await db
          .select()
          .from(leaderMemberships)
          .where(
            inArray(
              leaderMemberships.leader_entity_id,
              entityTree.map((e) => e.entity_id),
            ),
          )
      : [];

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
    // The ids never leave the server: they scope the withdrawals, credits,
    // transfers and bonuses below.
    let playerIds: number[] = [];
    if (canSeePlayers) {
      const idRows = await db
        .select({ player_id: players.player_id })
        .from(players)
        .where(playerScope);
      playerIds = idRows.map((p) => p.player_id);
    }

    // How many members each company holds — what the hierarchy pages were
    // counting by walking the roster.
    const playerCounts = canSeePlayers
      ? await db
          .select({
            company_entity_id: players.company_entity_id,
            members: sql<number>`count(*)::int`,
          })
          .from(players)
          .where(playerScope)
          .groupBy(players.company_entity_id)
      : [];

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
      /**
       * Withdrawals carry the member's company on the row.
       *
       * A withdrawal belongs to a company only through its player, and the
       * screens that scope by company used to look that up in the roster. The
       * roster is no longer shipped, and this is one join rather than twelve
       * thousand rows.
       */
      playerIds.length
        ? db
            .select({
              ...getTableColumns(withdrawals),
              company_entity_id: players.company_entity_id,
            })
            .from(withdrawals)
            .innerJoin(players, eq(players.player_id, withdrawals.player_id))
            .where(
              and(
                inArray(withdrawals.player_id, playerIds),
                csCutoffIso ? gte(withdrawals.created_at, csCutoffIso) : undefined,
              ),
            )
            .orderBy(desc(withdrawals.created_at))
            .limit(500)
        : user.companyIds === null
          ? db
              .select({
                ...getTableColumns(withdrawals),
                company_entity_id: players.company_entity_id,
              })
              .from(withdrawals)
              .innerJoin(players, eq(players.player_id, withdrawals.player_id))
              .orderBy(desc(withdrawals.created_at))
              .limit(500)
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
          two_factor_enabled: users.two_factor_enabled,
          telegram_username: users.telegram_username,
          ip_allowlist: users.ip_allowlist,
        })
        .from(users)
        .where(
          user.companyIds === null
            ? undefined
            : inArray(
                users.entity_id,
                /**
                 * Logins from the visible tree, minus the group's own.
                 *
                 * The tree includes ancestors so a card can be drawn with a
                 * name on it; that is display context, not a staff list. It
                 * meant a CS agent's hierarchy page listed every super admin's
                 * username — the accounts worth attacking, handed to the
                 * widest-held role in the company.
                 */
                entityTree
                  .filter(
                    (e) =>
                      user.role === "super_admin" ||
                      e.entity_type !== "main_company",
                  )
                  .map((e) => e.entity_id),
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

      /**
       * Expenses, scoped like everything else: a company's own.
       *
       * They were the admin's book alone, then admins plus bank charges. The
       * desk pays for things out of the company's accounts every day, so they
       * keep the same list — for their own companies, never the group's.
       */
      user.role === "super_admin"
        ? db
            .select()
            .from(expenses)
            .orderBy(desc(expenses.expense_date))
            .limit(500)
        : user.companyIds?.length
          ? db
              .select()
              .from(expenses)
              .where(inArray(expenses.company_entity_id, user.companyIds))
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
      companyLeaders: ownership,
      leaderMemberships: memberships,
      users: allUsers,
      // Per-company member counts, in place of the roster itself.
      playerCounts,
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

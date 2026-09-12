import { and, asc, desc, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { bonusPlans, deposits, players, withdrawals } from "@/db/schema";
import { AuthError, type AuthedUser } from "./auth";

export type BonusPlan = typeof bonusPlans.$inferSelect;
export type BonusPeriod = "daily" | "weekly" | "monthly";

/**
 * The business runs on Malaysian time (UTC+8, no DST) but the server runs on
 * UTC, so "once a day" has to be reckoned against a fixed offset or a bonus
 * claimed at 9am local would look like yesterday's claim to Postgres.
 */
export const BUSINESS_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * When the current daily/weekly/monthly window opened, in business time.
 * Weeks start Monday; months on the 1st.
 */
export function periodStart(period: BonusPeriod, now: Date = new Date()): Date {
  // Shift into business time so the UTC getters/setters read as local ones,
  // truncate there, then shift back.
  const local = new Date(now.getTime() + BUSINESS_UTC_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  if (period === "weekly") {
    const mondayIndex = (local.getUTCDay() + 6) % 7; // Sun=6, Mon=0
    local.setUTCDate(local.getUTCDate() - mondayIndex);
  } else if (period === "monthly") {
    local.setUTCDate(1);
  }
  return new Date(local.getTime() - BUSINESS_UTC_OFFSET_MS);
}

/** "today" / "this week" / "this month" — for reasons CS has to read out loud. */
export function periodPhrase(period: BonusPeriod): string {
  return period === "daily"
    ? "today"
    : period === "weekly"
      ? "this week"
      : "this month";
}

/** A date as CS would say it, in business time: "16 Aug, 09:14". */
function businessTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + BUSINESS_UTC_OFFSET_MS);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month}, ${hh}:${mm}`;
}

function rm(amount: number): string {
  return `RM ${amount.toFixed(2)}`;
}

/**
 * A deposit holds its bonus claim unless it failed.
 *
 * Anything still in flight counts as used: two pending deposits both claiming
 * today's daily bonus is exactly what this is here to stop. Rejecting a deposit
 * sets it to "failed", which hands the claim back.
 */
const CLAIM_RELEASING_STATUS = "failed" as const;

export type BonusVerdict = {
  eligible: boolean;
  /** Why not — user-facing, shown in the dropdown and returned on a 422. */
  reason: string | null;
  /** What this bonus would credit, given the deposit in front of us. */
  bonus_amount: number;
  /**
   * What the percentage was applied to: the deposit for welcome/recurring, the
   * player's net loss for a rebate. Stored on the deposit for rebates so the
   * figure that was paid out stays auditable.
   */
  basis_amount: number;
  /** Net loss over the period. Rebates only — null for other types. */
  net_loss: number | null;
};

export type BonusContext = {
  playerId: number;
  /** The player's company, for the plan's company scope. */
  companyEntityId: number | null;
  depositAmount: number;
  /**
   * The deposit being bonused, when it already exists. Excluded from every
   * lookback so a deposit never disqualifies itself — re-picking the same
   * bonus on the same row has to stay possible.
   */
  excludeDepositId?: number;
  now?: Date;
};

/** Net loss = completed deposits − paid withdrawals, over a window. Negative = the player is up. */
export async function netLossOverPeriod(
  playerId: number,
  since: Date,
  excludeDepositId?: number,
): Promise<number> {
  const sinceIso = since.toISOString();

  const [depositRow] = await db
    .select({ total: sql<number>`coalesce(sum(${deposits.deposit_amount}), 0)::float8` })
    .from(deposits)
    .where(
      and(
        eq(deposits.player_id, playerId),
        eq(deposits.status, "completed"),
        gte(deposits.deposit_date, sinceIso),
        excludeDepositId
          ? ne(deposits.deposit_id, excludeDepositId)
          : undefined,
      ),
    );

  // Paid withdrawals only: a request that hasn't been paid hasn't left the
  // player's balance, and counting it would rebate a loss they haven't taken.
  const [withdrawalRow] = await db
    .select({
      total: sql<number>`coalesce(sum(${withdrawals.requested_amount}), 0)::float8`,
    })
    .from(withdrawals)
    .where(
      and(
        eq(withdrawals.player_id, playerId),
        eq(withdrawals.status, "paid"),
        gte(withdrawals.paid_at, sinceIso),
      ),
    );

  return +((depositRow?.total ?? 0) - (withdrawalRow?.total ?? 0)).toFixed(2);
}

/** The most recent deposit that claimed this plan since `since`, if any. */
async function lastClaim(
  planId: number,
  playerId: number,
  since: Date,
  excludeDepositId?: number,
) {
  const [row] = await db
    .select({
      deposit_id: deposits.deposit_id,
      deposit_date: deposits.deposit_date,
    })
    .from(deposits)
    .where(
      and(
        eq(deposits.player_id, playerId),
        eq(deposits.bonus_plan_id, planId),
        ne(deposits.status, CLAIM_RELEASING_STATUS),
        gte(deposits.deposit_date, since.toISOString()),
        excludeDepositId ? ne(deposits.deposit_id, excludeDepositId) : undefined,
      ),
    )
    .orderBy(desc(deposits.deposit_date))
    .limit(1);
  return row ?? null;
}

/**
 * Decide whether a player may have a bonus, and what it is worth.
 *
 * Every check that can fail returns the reason it failed, because "not
 * eligible" on its own sends CS to ask someone. The checks run cheapest-first
 * and stop at the first failure, so an inactive plan never costs a loss query.
 *
 * This is a read: the caller writes the deposit afterwards, so two deposits
 * submitted in the same instant could both pass. That race is left open
 * deliberately — the alternative is locking the player row on every dropdown
 * repaint, and the losing case is one duplicated bonus that the audit log
 * still shows, not lost money.
 */
export async function evaluateBonusPlan(
  plan: BonusPlan,
  ctx: BonusContext,
): Promise<BonusVerdict> {
  const now = ctx.now ?? new Date();
  const deny = (reason: string): BonusVerdict => ({
    eligible: false,
    reason,
    bonus_amount: 0,
    basis_amount: 0,
    net_loss: null,
  });

  if (plan.status !== "active") {
    return deny(`"${plan.name}" is switched off`);
  }
  // Rebates are paid from the Rebates page's generated list, never on a
  // deposit — one place pays them, so nothing can pay one twice.
  if (plan.type === "rebate") {
    return deny(`"${plan.name}" is a rebate — it's paid from the Rebates page, not on a deposit`);
  }
  if (
    plan.company_entity_id !== null &&
    plan.company_entity_id !== ctx.companyEntityId
  ) {
    return deny(`"${plan.name}" is reserved for another company`);
  }
  if (ctx.depositAmount < plan.min_deposit) {
    return deny(
      `"${plan.name}" needs a deposit of at least ${rm(plan.min_deposit)} — this one is ${rm(ctx.depositAmount)}`,
    );
  }

  if (plan.type === "welcome") {
    const firstDeposit = await isFirstDeposit(ctx.playerId, ctx.excludeDepositId);
    if (!firstDeposit.yes) return deny(`"${plan.name}" ${firstDeposit.why}`);
    const amount = pct(ctx.depositAmount, plan.percentage);
    return {
      eligible: true,
      reason: null,
      bonus_amount: amount,
      basis_amount: ctx.depositAmount,
      net_loss: null,
    };
  }

  // Recurring and rebate both claim once per window; the window is the plan's.
  const period = (plan.period ?? "daily") as BonusPeriod;
  const since = periodStart(period, now);
  const claimed = await lastClaim(
    plan.plan_id,
    ctx.playerId,
    since,
    ctx.excludeDepositId,
  );
  if (claimed) {
    return deny(
      `"${plan.name}" was already claimed ${periodPhrase(period)} (deposit #${claimed.deposit_id}, ${businessTime(claimed.deposit_date)})`,
    );
  }

  if (plan.type === "recurring") {
    const amount = pct(ctx.depositAmount, plan.percentage);
    return {
      eligible: true,
      reason: null,
      bonus_amount: amount,
      basis_amount: ctx.depositAmount,
      net_loss: null,
    };
  }

  // Rebate: pays a share of what the player actually lost over the period.
  const loss = await netLossOverPeriod(ctx.playerId, since, ctx.excludeDepositId);
  if (loss <= 0) {
    return {
      ...deny(
        loss === 0
          ? `"${plan.name}" needs a loss — this player is level ${periodPhrase(period)}`
          : `"${plan.name}" needs a loss — this player is up ${rm(-loss)} ${periodPhrase(period)}`,
      ),
      net_loss: loss,
    };
  }
  if (loss < plan.min_loss) {
    return {
      ...deny(
        `"${plan.name}" needs a loss of at least ${rm(plan.min_loss)} — this player is down ${rm(loss)} ${periodPhrase(period)}`,
      ),
      net_loss: loss,
    };
  }
  return {
    eligible: true,
    reason: null,
    bonus_amount: pct(loss, plan.percentage),
    basis_amount: loss,
    net_loss: loss,
  };
}

function pct(base: number, percentage: number): number {
  return +((base * percentage) / 100).toFixed(2);
}

/**
 * Is this the player's first deposit?
 *
 * Two sources, because neither is enough alone: any other deposit row that
 * hasn't failed, and `total_deposits`, which carries the history of players
 * imported from a previous system with no deposit rows behind them.
 */
async function isFirstDeposit(
  playerId: number,
  excludeDepositId?: number,
): Promise<{ yes: boolean; why: string }> {
  const [player] = await db
    .select({ total_deposits: players.total_deposits })
    .from(players)
    .where(eq(players.player_id, playerId));
  if (player && player.total_deposits > 0) {
    return {
      yes: false,
      why: `is first-deposit only — this player has already deposited ${rm(player.total_deposits)}`,
    };
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deposits)
    .where(
      and(
        eq(deposits.player_id, playerId),
        ne(deposits.status, CLAIM_RELEASING_STATUS),
        excludeDepositId ? ne(deposits.deposit_id, excludeDepositId) : undefined,
      ),
    );
  const earlier = row?.count ?? 0;
  if (earlier > 0) {
    return {
      yes: false,
      why: `is first-deposit only — this player already has ${earlier} other deposit${earlier === 1 ? "" : "s"} on record`,
    };
  }
  return { yes: true, why: "" };
}

/**
 * Every plan a player could be offered, each with its verdict.
 *
 * Inactive plans and other companies' plans are dropped rather than returned as
 * ineligible — they aren't choices anyone should see. Everything else comes
 * back either way, because a greyed-out row that says why is how CS learns the
 * rules.
 */
export async function evaluatePlansForPlayer(
  ctx: BonusContext,
): Promise<Array<{ plan: BonusPlan; verdict: BonusVerdict }>> {
  const all = await db
    .select()
    .from(bonusPlans)
    .where(eq(bonusPlans.status, "active"))
    .orderBy(asc(bonusPlans.type), asc(bonusPlans.name));

  const offered = all.filter(
    (p) =>
      // Rebates don't ride a deposit — see the Rebates page.
      p.type !== "rebate" &&
      (p.company_entity_id === null ||
        p.company_entity_id === ctx.companyEntityId),
  );

  return Promise.all(
    offered.map(async (plan) => ({
      plan,
      verdict: await evaluateBonusPlan(plan, ctx),
    })),
  );
}

/** Fields a deposit takes on when a plan is applied to it (or cleared). */
export type BonusFields = {
  bonus_plan_id: number | null;
  bonus_percentage: number;
  bonus_amount: number;
  bonus_basis_amount: number | null;
  bonus_override_reason: string | null;
  total_amount: number;
};

/** Only a leader or the super admin can put a bonus on a player who didn't earn it. */
export function canOverrideEligibility(role: string): boolean {
  return role === "super_admin" || role === "company_leader";
}

/**
 * Who may own a plan.
 *
 * A super admin writes the house rules — including the global ones every
 * company gets. A leader may only create plans pinned to a company they own,
 * so one leader can't quietly change what another leader's CS agents hand out.
 */
export async function assertPlanScope(
  user: AuthedUser,
  companyEntityId: number | null | undefined,
): Promise<void> {
  if (user.role === "super_admin") return;
  if (user.role !== "company_leader") {
    throw new AuthError(403, "Only leaders and admins manage bonuses");
  }
  if (companyEntityId == null) {
    throw new AuthError(
      403,
      "Only the super admin creates bonuses that apply to every company",
    );
  }
  if (user.companyIds !== null && !user.companyIds.includes(companyEntityId)) {
    throw new AuthError(403, "Company is outside your scope");
  }
}

/**
 * Resolve "CS picked plan X for this deposit" into the columns to write.
 *
 * Returns the reason instead of the fields when the player isn't eligible and
 * the caller hasn't been allowed to override, so the route can 422 with the
 * same sentence the dropdown showed.
 */
export async function resolveBonusForDeposit(input: {
  planId: number | null;
  /** Used only when planId is null: the old free-percentage path. */
  fallbackPercentage?: number;
  ctx: BonusContext;
  override?: { allowed: boolean; reason?: string | null };
}): Promise<
  | { ok: true; fields: BonusFields; verdict: BonusVerdict | null; plan: BonusPlan | null }
  | { ok: false; reason: string; status: number }
> {
  const { ctx } = input;

  // No plan: an ad-hoc percentage, unchanged from how deposits worked before
  // plans existed. Nothing to validate beyond the number itself.
  if (input.planId === null) {
    const percentage = input.fallbackPercentage ?? 0;
    const amount = pct(ctx.depositAmount, percentage);
    return {
      ok: true,
      plan: null,
      verdict: null,
      fields: {
        bonus_plan_id: null,
        bonus_percentage: percentage,
        bonus_amount: amount,
        bonus_basis_amount: null,
        bonus_override_reason: null,
        total_amount: +(ctx.depositAmount + amount).toFixed(2),
      },
    };
  }

  const [plan] = await db
    .select()
    .from(bonusPlans)
    .where(eq(bonusPlans.plan_id, input.planId));
  if (!plan) return { ok: false, reason: "Bonus not found", status: 404 };
  // Not even an override puts a rebate on a deposit — it's paid from the
  // Rebates page against the player's measured loss.
  if (plan.type === "rebate") {
    return {
      ok: false,
      reason: `"${plan.name}" is a rebate — pay it from the Rebates page`,
      status: 422,
    };
  }

  const verdict = await evaluateBonusPlan(plan, ctx);
  if (!verdict.eligible) {
    if (!input.override?.allowed) {
      return { ok: false, reason: verdict.reason ?? "Not eligible", status: 422 };
    }
    // Forced through: the bonus still pays what the rule says it is worth —
    // the deposit is the basis (rebates never reach here; they're paid from
    // the Rebates page against the measured loss).
    const basis = verdict.basis_amount || ctx.depositAmount;
    const amount = pct(basis, plan.percentage);
    return {
      ok: true,
      plan,
      verdict,
      fields: {
        bonus_plan_id: plan.plan_id,
        bonus_percentage: plan.percentage,
        bonus_amount: amount,
        bonus_basis_amount: null,
        bonus_override_reason:
          input.override?.reason?.trim() || `Override: ${verdict.reason}`,
        total_amount: +(ctx.depositAmount + amount).toFixed(2),
      },
    };
  }

  return {
    ok: true,
    plan,
    verdict,
    fields: {
      bonus_plan_id: plan.plan_id,
      bonus_percentage: plan.percentage,
      bonus_amount: verdict.bonus_amount,
      bonus_basis_amount: null,
      bonus_override_reason: null,
      total_amount: +(ctx.depositAmount + verdict.bonus_amount).toFixed(2),
    },
  };
}

/** Plans that reference this deposit's player — used to guard plan deletion. */
export async function planUsageCount(planId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deposits)
    .where(eq(deposits.bonus_plan_id, planId));
  return row?.count ?? 0;
}

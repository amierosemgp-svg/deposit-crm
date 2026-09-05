import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

// ---------- Enums ----------

export const entityTypeEnum = pgEnum("entity_type", [
  "main_company",
  "leader",
  "company",
  "cs",
]);

export const userRoleEnum = pgEnum("user_role", [
  "super_admin",
  "company_leader",
  "cs_agent",
  "viewer",
]);

export const activeStatusEnum = pgEnum("active_status", ["active", "inactive"]);

export const playerStatusEnum = pgEnum("player_status", ["active", "suspended"]);

/** Who created a transaction: the agent (auto-detected) or a person (manual). */
export const transactionSourceEnum = pgEnum("transaction_source", [
  "bot",
  "manual",
]);

/** Reported run-state of a bot process (see bot_health). */
export const botStateEnum = pgEnum("bot_state", [
  "starting",
  "working",
  "idle",
  "stuck",
  "error",
  "maintenance",
  "stopped",
]);

export const bankAccountRoleEnum = pgEnum("bank_account_role", [
  "deposit",
  "withdrawal",
]);

export const bankTransferStatusEnum = pgEnum("bank_transfer_status", [
  "pending_confirmation",
  "confirmed",
  "auto_confirmed",
  "rejected",
  "failed",
]);

export const depositStatusEnum = pgEnum("deposit_status", [
  "pending_match", // intent created, waiting for bot to confirm bank credit
  "matched", // bot confirmed the bank transaction
  "pending", // waiting for CS bonus/game/approval
  "approved",
  "processing",
  "completed",
  "failed",
]);

export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  "requested",
  "credits_pulled",
  "paid",
  "failed",
]);

export const referralBonusStatusEnum = pgEnum("referral_bonus_status", [
  // Earned and waiting for CS to hand it out.
  "pending",
  // Credited to one of the upline's games.
  "assigned",
  // Written off — a mistaken referral, a reversed deposit, a duplicate account.
  "cancelled",
]);

/**
 * What entitles a player to a bonus:
 *  - welcome   — their first deposit, once ever
 *  - recurring — claimable once per period (daily/weekly/monthly)
 *  - rebate    — a share of what they lost over the period, once per period
 */
export const bonusPlanTypeEnum = pgEnum("bonus_plan_type", [
  "welcome",
  "recurring",
  "rebate",
]);

export const bonusPeriodEnum = pgEnum("bonus_period", [
  "daily",
  "weekly",
  "monthly",
]);

export const gameAccountActionEnum = pgEnum("game_account_action", [
  "added",
  "updated",
  "removed",
]);

export const botEventLevelEnum = pgEnum("bot_event_level", [
  "debug",
  "info",
  "warn",
  "error",
]);

/**
 * What the CRM is asking the agent to go and do, right now.
 *
 *   crawl_bank — re-read the online-banking transaction list for the target
 *   account(s) immediately, instead of waiting for the next scheduled sweep.
 *
 * One value today; it is an enum because the next on-demand job (re-check a
 * kiosk balance, re-read a provider back-office) belongs in the same queue and
 * should not need a second table.
 */
export const botCommandEnum = pgEnum("bot_command", ["crawl_bank"]);

/**
 * An on-demand command's lifecycle:
 *
 *   pending ──agent claims──▶ running ──▶ completed
 *      │                         └──────▶ failed
 *      └── nobody claimed in time ──────▶ expired
 *
 * "expired" is the one that matters operationally: a crawl someone asked for at
 * 09:00 must not fire at 14:00 when the agent finally comes back up. By then
 * the scheduled sweep has long since covered it, and the CS who pressed the
 * button has stopped waiting. See BOT_COMMAND_TTL_MS.
 */
export const botCommandStatusEnum = pgEnum("bot_command_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "expired",
]);

export const poolAccountStatusEnum = pgEnum("pool_account_status", [
  // Registered at the provider, not yet handed to a player.
  "available",
  // Handed to a player; game_accounts on that player is the live record.
  "assigned",
  // Withdrawn from circulation (banned, provider closed it, bad batch).
  "retired",
]);

/**
 * A CS-requested transfer's lifecycle:
 *
 *   pending ──agent claims──▶ processing ──▶ completed
 *      ▲                        │      └──▶ failed
 *      └──── solving ◀── stalled ┘
 *
 * "pending" is a transfer waiting for the agent to pick it up; "solving" is one
 * the recovery sweep re-queued after the agent went quiet on it. Both are work
 * the agent should claim; solving additionally means "you have seen this before".
 */
export const gameTransferStatusEnum = pgEnum("game_transfer_status", [
  "pending",
  "solving",
  "processing",
  "completed",
  "failed",
]);

export const auditTypeEnum = pgEnum("audit_type", [
  "deposit",
  "withdrawal",
  "game_topup",
  "game_transfer",
  "credit_pull",
  "bank_transfer",
  "bo_adjustment",
  "player_import",
  // Referral payout credited to an upline. Kept apart from game_topup so
  // bonus spend can be totalled without unpicking deposit-driven top-ups.
  "recommend_bonus",
  // A settlement moving funds from one leader to another. Deliberately its own
  // type — not an expense — so leader-to-leader movement reports on its own.
  "leader_transfer",
]);

// ---------- Core hierarchy ----------

export const entities = pgTable("entities", {
  entity_id: serial("entity_id").primaryKey(),
  parent_entity_id: integer("parent_entity_id"),
  entity_type: entityTypeEnum("entity_type").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  status: activeStatusEnum("status").notNull().default("active"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export const users = pgTable("users", {
  user_id: serial("user_id").primaryKey(),
  username: varchar("username", { length: 60 }).notNull(),
  email: varchar("email", { length: 160 }).notNull().unique(),
  full_name: varchar("full_name", { length: 120 }).notNull(),
  password_hash: varchar("password_hash", { length: 100 }).notNull(),
  role: userRoleEnum("role").notNull(),
  entity_id: integer("entity_id")
    .notNull()
    .references(() => entities.entity_id),
  status: activeStatusEnum("status").notNull().default("active"),
  last_login_at: timestamp("last_login_at", { withTimezone: true, mode: "string" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

/**
 * A real person — one row per phone number for the whole database.
 *
 * Identity is global: the same person appears under many companies as separate
 * `players` (member) rows, but exists here once. One phone number is one
 * person; the same human with two numbers is two people (never deduped by name).
 */
export const people = pgTable("people", {
  person_id: serial("person_id").primaryKey(),
  // The identity key. Globally unique when present; a person with no number on
  // file is kept distinct (never merged) and flagged for review.
  contact_number: varchar("contact_number", { length: 40 }).unique(),
  full_name: varchar("full_name", { length: 120 }).notNull(),
  telegram_username: varchar("telegram_username", { length: 80 }),
  wechat_id: varchar("wechat_id", { length: 80 }),
  // Set when migration couldn't be sure of identity — a blank or duplicated
  // phone. A human reconciles these; nothing auto-merges.
  needs_review: boolean("needs_review").notNull().default(false),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

/**
 * A list of leads a leader buys ("list_A"). Grows continuously as they buy more.
 * The prefix (e.g. "A") labels the list's own lead codes (A0001, A0002…).
 */
export const leadLists = pgTable("lead_lists", {
  list_id: serial("list_id").primaryKey(),
  owner_leader_entity_id: integer("owner_leader_entity_id")
    .notNull()
    .references(() => entities.entity_id),
  name: varchar("name", { length: 120 }).notNull(),
  prefix: varchar("prefix", { length: 16 }).notNull(),
  // Running counter for the next lead code in this list.
  next_seq: integer("next_seq").notNull().default(1),
  notes: text("notes"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

/** One lead in a list — a person with the list's own code (A0001). */
export const listLeads = pgTable(
  "list_leads",
  {
    lead_id: serial("lead_id").primaryKey(),
    list_id: integer("list_id")
      .notNull()
      .references(() => leadLists.list_id),
    person_id: integer("person_id")
      .notNull()
      .references(() => people.person_id),
    lead_code: varchar("lead_code", { length: 40 }).notNull(),
    seq: integer("seq").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("list_leads_person_key").on(t.list_id, t.person_id),
    unique("list_leads_seq_key").on(t.list_id, t.seq),
  ],
);

/**
 * A hand-off of a list to a company (or another leader). This is where the
 * per-company code prefix and its auto-increment counter live: converting a
 * lead into a member takes `next_seq`, stamps member_code = prefix + seq, bumps.
 */
export const listDistributions = pgTable(
  "list_distributions",
  {
    dist_id: serial("dist_id").primaryKey(),
    list_id: integer("list_id")
      .notNull()
      .references(() => leadLists.list_id),
    // A company (converts leads to members) or a leader (re-distributes).
    to_entity_id: integer("to_entity_id")
      .notNull()
      .references(() => entities.entity_id),
    // The prefix this company stamps on members converted from the list ("AZ").
    prefix: varchar("prefix", { length: 16 }).notNull(),
    next_seq: integer("next_seq").notNull().default(1),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("list_distributions_key").on(t.list_id, t.to_entity_id)],
);

export const players = pgTable("players", {
  player_id: serial("player_id").primaryKey(),
  username: varchar("username", { length: 60 }).notNull().unique(),
  full_name: varchar("full_name", { length: 120 }).notNull(),
  contact_number: varchar("contact_number", { length: 40 }),
  // The global identity this membership belongs to. Nullable only mid-migration.
  person_id: integer("person_id").references(() => people.person_id),
  // Which list distribution this member was converted from (null = direct/legacy).
  source_dist_id: integer("source_dist_id"),
  telegram_username: varchar("telegram_username", { length: 80 }),
  wechat_id: varchar("wechat_id", { length: 80 }),
  company_entity_id: integer("company_entity_id")
    .notNull()
    .references(() => entities.entity_id),
  bank_accounts: jsonb("bank_accounts").$type<
    Array<{ bank_name: string; account_number: string; account_holder: string }>
  >(),
  game_accounts: jsonb("game_accounts").$type<
    Array<{ game_name: string; game_username: string }>
  >(),
  // Who referred this player. One upline per player, set by CS — the referral
  // tree is an adjacency list, not a separate join table, because a player can
  // only ever have been referred once.
  upline_player_id: integer("upline_player_id"),
  upline_assigned_at: timestamp("upline_assigned_at", {
    withTimezone: true,
    mode: "string",
  }),
  registration_date: timestamp("registration_date", {
    withTimezone: true,
    mode: "string",
  })
    .notNull()
    .defaultNow(),
  // Maintained by a database trigger (2026-08-27-players-updated-at.sql), not
  // by application code: players are written from the CRM API, the agent API
  // and import scripts, and /api/state uses this to decide whether it can skip
  // re-sending the 1.5 MB roster. A stamp one write path could forget would
  // serve stale data as fresh.
  updated_at: timestamp("updated_at", {
    withTimezone: true,
    mode: "string",
  })
    .notNull()
    .defaultNow(),
  status: playerStatusEnum("status").notNull().default("active"),
  total_deposits: numeric("total_deposits", {
    precision: 12,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  total_withdrawals: numeric("total_withdrawals", {
    precision: 12,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  notes: text("notes"),
});

/**
 * A member's bank accounts, per company. Moved off players.bank_accounts jsonb
 * so the "unique within a company" rule can be a real constraint.
 */
export const memberBankAccounts = pgTable(
  "member_bank_accounts",
  {
    id: serial("id").primaryKey(),
    // The member (players row) this account belongs to.
    member_id: integer("member_id")
      .notNull()
      .references(() => players.player_id),
    // Denormalised for the per-company uniqueness constraint.
    company_entity_id: integer("company_entity_id")
      .notNull()
      .references(() => entities.entity_id),
    bank_name: varchar("bank_name", { length: 60 }).notNull(),
    account_number: varchar("account_number", { length: 60 }).notNull(),
    account_holder: varchar("account_holder", { length: 120 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One account number can recur across companies, never within one.
    unique("member_bank_company_account_key").on(t.company_entity_id, t.account_number),
  ],
);

/** A member's kiosk logins, per company. Moved off players.game_accounts jsonb. */
export const memberGameAccounts = pgTable(
  "member_game_accounts",
  {
    id: serial("id").primaryKey(),
    member_id: integer("member_id")
      .notNull()
      .references(() => players.player_id),
    game_name: varchar("game_name", { length: 60 }).notNull(),
    game_username: varchar("game_username", { length: 120 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The same login can't be linked twice on one member.
    unique("member_game_login_key").on(t.member_id, t.game_name, t.game_username),
  ],
);

// ---------- Money ----------

export const bankAccounts = pgTable("bank_accounts", {
  account_id: serial("account_id").primaryKey(),
  entity_id: integer("entity_id")
    .notNull()
    .references(() => entities.entity_id),
  role: bankAccountRoleEnum("role").notNull(),
  bank_name: varchar("bank_name", { length: 60 }).notNull(),
  account_number: varchar("account_number", { length: 60 }).notNull(),
  account_holder: varchar("account_holder", { length: 120 }).notNull(),
  label: varchar("label", { length: 60 }),
  // Online-banking credentials the AI agent uses to query the account.
  // Enterprise accounts sign in with a company ID before the user ID; personal
  // accounts leave this null.
  login_company_id: varchar("login_company_id", { length: 80 }),
  login_id: varchar("login_id", { length: 80 }),
  login_password: varchar("login_password", { length: 120 }),
  login_pin: varchar("login_pin", { length: 20 }),
  // The device this account's banking app is bound to. Banks tie a login to
  // one registered device, so when a balance stops updating the question is
  // which device was on it — the agent reports this as it picks the account up.
  device_id: varchar("device_id", { length: 120 }),
  // Last time the AI agent pinged us for this account (heartbeat/online status).
  last_heartbeat_at: timestamp("last_heartbeat_at", {
    withTimezone: true,
    mode: "string",
  }),
  current_balance: numeric("current_balance", {
    precision: 14,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  status: activeStatusEnum("status").notNull().default("active"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export const bankTransfers = pgTable("bank_transfers", {
  transfer_id: serial("transfer_id").primaryKey(),
  from_account_id: integer("from_account_id")
    .notNull()
    .references(() => bankAccounts.account_id),
  to_account_id: integer("to_account_id")
    .notNull()
    .references(() => bankAccounts.account_id),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  reference: varchar("reference", { length: 80 }),
  notes: text("notes"),
  status: bankTransferStatusEnum("status").notNull().default("pending_confirmation"),
  // When true the transfer is handled manually: the agent never acts on it and
  // the confirmation window never auto-confirms — a human confirms/rejects.
  skip_bot: boolean("skip_bot").notNull().default(false),
  // Nullable: agent/system-initiated transfers have no human user.
  initiated_by_user_id: integer("initiated_by_user_id").references(
    () => users.user_id,
  ),
  confirmed_by_user_id: integer("confirmed_by_user_id").references(
    () => users.user_id,
  ),
  confirmed_at: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
  expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

/**
 * A bonus CS can put on a deposit, and the rule that decides who may have it.
 *
 * The percentage on its own was never the interesting part — the rule is. A
 * plan carries both, so picking a bonus is one choice ("Welcome 100%") that the
 * server can then check against the player's own history rather than trusting
 * whoever opened the dropdown.
 *
 * Editing a plan changes what future deposits get, never what past ones got:
 * the deposit snapshots its percentage and amount at the time it was applied.
 */
export const bonusPlans = pgTable(
  "bonus_plans",
  {
    plan_id: serial("plan_id").primaryKey(),
    name: varchar("name", { length: 80 }).notNull(),
    type: bonusPlanTypeEnum("type").notNull(),
    // How often it may be claimed. Null for "welcome" — that one is once ever.
    period: bonusPeriodEnum("period"),
    percentage: numeric("percentage", {
      precision: 5,
      scale: 2,
      mode: "number",
    }).notNull(),
    // Gate on the deposit being made. 0 = no minimum.
    min_deposit: numeric("min_deposit", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    // Rebate only: how far down the player must be over the period before the
    // rebate is offered at all. 0 = any loss qualifies.
    min_loss: numeric("min_loss", { precision: 12, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    // Null = offered to every company. Set to reserve the plan to one company.
    company_entity_id: integer("company_entity_id").references(
      () => entities.entity_id,
    ),
    status: activeStatusEnum("status").notNull().default("active"),
    notes: text("notes"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Two plans of the same name in one scope is a CS trap, not a feature.
    // NULLS NOT DISTINCT because the house-wide plans are exactly the ones with
    // a null company — under the default rule every one of them would be
    // considered unique from every other, which is the opposite of the point.
    unique("bonus_plans_name_scope_key")
      .on(t.name, t.company_entity_id)
      .nullsNotDistinct(),
  ],
);

export const deposits = pgTable("deposits", {
  deposit_id: serial("deposit_id").primaryKey(),
  // Agent idempotency key — the agent's own queue id, e.g.
  // "25_Jun_2026_Hello_TAN_KIEN_HUAT_*Fund_Transfer_2.0"
  external_id: varchar("external_id", { length: 200 }).unique(),
  transaction_ref: varchar("transaction_ref", { length: 80 }).notNull(),
  deposit_date: timestamp("deposit_date", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  // Did the agent report a time of day, or only a calendar date? A date-only
  // report ("25 Jun 2026") is stored as midnight UTC, and showing that back as
  // a clock reading invents precision nobody supplied — the UI renders just the
  // date when this is false.
  deposit_time_known: boolean("deposit_time_known").notNull().default(true),
  player_id: integer("player_id").references(() => players.player_id),
  player_username: varchar("player_username", { length: 60 }),
  company_entity_id: integer("company_entity_id").references(
    () => entities.entity_id,
  ),
  deposit_amount: numeric("deposit_amount", {
    precision: 12,
    scale: 2,
    mode: "number",
  }).notNull(),
  bank_name: varchar("bank_name", { length: 60 }).notNull(),
  bank_account_number: varchar("bank_account_number", { length: 60 }),
  bank_account_holder: varchar("bank_account_holder", { length: 120 }),
  bank_description: text("bank_description"), // raw description from the bot
  received_into_account_id: integer("received_into_account_id").references(
    () => bankAccounts.account_id,
  ),
  // Which bonus was applied. Null = an ad-hoc percentage with no plan behind
  // it — still allowed, and what every deposit taken before plans existed is.
  bonus_plan_id: integer("bonus_plan_id").references(() => bonusPlans.plan_id),
  // Set when a leader/admin forced a bonus the player did not qualify for.
  // Null on every deposit that passed the eligibility check on its own.
  bonus_override_reason: text("bonus_override_reason"),
  // What the percentage was applied to, when that isn't the deposit itself:
  // for a rebate it's the net loss over the period. Snapshotted so a later
  // deposit or withdrawal can never rewrite a rebate that was already paid.
  bonus_basis_amount: numeric("bonus_basis_amount", {
    precision: 12,
    scale: 2,
    mode: "number",
  }),
  bonus_percentage: numeric("bonus_percentage", {
    precision: 5,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  bonus_amount: numeric("bonus_amount", { precision: 12, scale: 2, mode: "number" })
    .notNull()
    .default(0),
  total_amount: numeric("total_amount", { precision: 12, scale: 2, mode: "number" })
    .notNull()
    .default(0),
  selected_game: varchar("selected_game", { length: 60 }),
  // Which login under selected_game this top-up targets. Null = the player's
  // first (or only) account for the game — the pre-multi-account default.
  selected_game_username: varchar("selected_game_username", { length: 120 }),
  status: depositStatusEnum("status").notNull().default("pending"),
  // Agent-detected bank credits default to "agent"; CRM-entered deposits set "manual".
  source: transactionSourceEnum("source").notNull().default("bot"),
  // When true the deposit is fully manual: the agent never matches or tops it up;
  // a human approves → processing → completes (or rejects) it.
  skip_bot: boolean("skip_bot").notNull().default(false),
  matched_at: timestamp("matched_at", { withTimezone: true, mode: "string" }),
  /**
   * When the deposit stopped waiting on a human — the moment it was approved
   * and dispatched, whether by CS pressing Approve or by the agent driving it
   * out of pending/matched itself.
   *
   * Distinct from `updated_at`, which every later transition overwrites, and
   * from `deposit_date`, which is when the money arrived. The gap between the
   * two is the queue time CS is measured on, so it needs a column of its own.
   *
   * Set once and only once: the *first* approval wins, so a later
   * processing→completed never rewrites it. Cleared by a reprocess, because a
   * deposit sent back to pending is genuinely waiting on a human again.
   *
   * Null on deposits that have never been approved — and on ones approved
   * before this column existed whose ledger left no trace of the moment.
   */
  approved_at: timestamp("approved_at", { withTimezone: true, mode: "string" }),
  handled_by_user_id: integer("handled_by_user_id").references(() => users.user_id),
  // The CS agent who claimed this deposit ("Assign to me").
  assigned_to_user_id: integer("assigned_to_user_id").references(
    () => users.user_id,
  ),
  assigned_at: timestamp("assigned_at", { withTimezone: true, mode: "string" }),
  game_topup_reference: varchar("game_topup_reference", { length: 80 }),
  receipt_url: text("receipt_url"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export const withdrawals = pgTable("withdrawals", {
  withdrawal_id: serial("withdrawal_id").primaryKey(),
  player_id: integer("player_id")
    .notNull()
    .references(() => players.player_id),
  // 0 when withdraw_all is set — the figure isn't known until the agent looks.
  requested_amount: numeric("requested_amount", {
    precision: 12,
    scale: 2,
    mode: "number",
  }).notNull(),
  /**
   * Empty the wallet, whatever is in it.
   *
   * game_credits is a cache that lags the provider, so an amount typed against
   * it can be wrong in both directions. This says "take the lot" and leaves the
   * figure to be discovered at pull time.
   */
  withdraw_all: boolean("withdraw_all").notNull().default(false),
  game_name: varchar("game_name", { length: 60 }).notNull(),
  // Which login under game_name to pull from. Null = the player's first account.
  game_username: varchar("game_username", { length: 120 }),
  credit_pulled_amount: numeric("credit_pulled_amount", {
    precision: 12,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  status: withdrawalStatusEnum("status").notNull().default("requested"),
  // When true the agent never auto-pulls/pays this withdrawal; CS handles it
  // manually (pull → paid) and can reject it.
  skip_bot: boolean("skip_bot").notNull().default(false),
  // CS-entered requests default to "manual"; agent-created requests set "agent".
  source: transactionSourceEnum("source").notNull().default("manual"),
  handled_by_user_id: integer("handled_by_user_id").references(() => users.user_id),
  // The CS agent who claimed this withdrawal ("Assign to me").
  assigned_to_user_id: integer("assigned_to_user_id").references(
    () => users.user_id,
  ),
  assigned_at: timestamp("assigned_at", { withTimezone: true, mode: "string" }),
  bank_name: varchar("bank_name", { length: 60 }),
  bank_account_number: varchar("bank_account_number", { length: 60 }),
  paid_from_account_id: integer("paid_from_account_id").references(
    () => bankAccounts.account_id,
  ),
  proof_url: text("proof_url"),
  paid_at: timestamp("paid_at", { withTimezone: true, mode: "string" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

/**
 * Every change to a player's game accounts, one row per account touched.
 * players.game_accounts is a jsonb blob that gets rewritten wholesale on edit,
 * so without this there is no record of who removed an account or what the
 * game id used to be — the question CS actually asks after a bad top-up.
 */
export const gameAccountAudit = pgTable("game_account_audit", {
  audit_id: serial("audit_id").primaryKey(),
  player_id: integer("player_id")
    .notNull()
    .references(() => players.player_id),
  game_name: varchar("game_name", { length: 60 }).notNull(),
  action: gameAccountActionEnum("action").notNull(),
  // Null on "added"; the game id as it was before the change otherwise.
  old_game_username: varchar("old_game_username", { length: 120 }),
  // Null on "removed"; the game id as it is after the change otherwise.
  new_game_username: varchar("new_game_username", { length: 120 }),
  // Null when the agent made the change rather than a person.
  changed_by_user_id: integer("changed_by_user_id").references(
    () => users.user_id,
  ),
  source: transactionSourceEnum("source").notNull().default("manual"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

/**
 * Game accounts the agent has registered at a provider ahead of demand.
 *
 * Registering an account takes a round-trip to the provider back-office, which
 * is far too slow to do while a player waits. The agent creates them in batches
 * and pushes them here; assigning one to a player is then just claiming a row.
 *
 * The pool is a staging area, not the source of truth — once assigned, the
 * player's own game_accounts list is what the rest of the CRM reads. The row
 * stays behind so it can't be handed out twice and so there's a record of where
 * the id came from.
 */
export const gameAccountPool = pgTable(
  "game_account_pool",
  {
    pool_id: serial("pool_id").primaryKey(),
    game_name: varchar("game_name", { length: 60 }).notNull(),
    game_username: varchar("game_username", { length: 120 }).notNull(),
    // Optional: some providers hand back a password the player needs.
    game_password: varchar("game_password", { length: 120 }),
    // Null = usable by any company. Set to reserve a batch for one company.
    company_entity_id: integer("company_entity_id").references(
      () => entities.entity_id,
    ),
    status: poolAccountStatusEnum("status").notNull().default("available"),
    assigned_player_id: integer("assigned_player_id").references(
      () => players.player_id,
    ),
    assigned_at: timestamp("assigned_at", {
      withTimezone: true,
      mode: "string",
    }),
    // Why it was retired, or any note the agent attached on creation.
    note: text("note"),
    source: transactionSourceEnum("source").notNull().default("bot"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The same provider account must never enter the pool twice — that's how
    // two players end up sharing one game id.
    unique("game_account_pool_game_username_key").on(
      t.game_name,
      t.game_username,
    ),
  ],
);

/**
 * A referral bonus the upline earned from a downline's FIRST deposit.
 *
 * Created automatically when a downline's first deposit completes, then handed
 * out by CS: they pick which of the upline's games the credit goes to and
 * whether the agent moves it or they did it by hand.
 *
 * The bonus is a snapshot — deposit_amount and percentage are copied in, so
 * changing the rate later never rewrites what someone already earned.
 */
export const referralBonuses = pgTable(
  "referral_bonuses",
  {
    bonus_id: serial("bonus_id").primaryKey(),
    // Who earns it.
    upline_player_id: integer("upline_player_id")
      .notNull()
      .references(() => players.player_id),
    // Whose first deposit triggered it.
    downline_player_id: integer("downline_player_id")
      .notNull()
      .references(() => players.player_id),
    deposit_id: integer("deposit_id").references(() => deposits.deposit_id),
    deposit_amount: numeric("deposit_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    bonus_percentage: numeric("bonus_percentage", {
      precision: 5,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(20),
    bonus_amount: numeric("bonus_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    status: referralBonusStatusEnum("status").notNull().default("pending"),
    // Chosen at assign time — which of the upline's games the credit went to.
    game_name: varchar("game_name", { length: 60 }),
    // True when CS moved the credit in the back-office themselves; false means
    // the agent was asked to do it via a game transfer.
    skip_bot: boolean("skip_bot").notNull().default(false),
    // The agent-driven transfer that carries the credit, when one was created.
    game_transfer_id: integer("game_transfer_id"),
    assigned_by_user_id: integer("assigned_by_user_id").references(
      () => users.user_id,
    ),
    assigned_at: timestamp("assigned_at", {
      withTimezone: true,
      mode: "string",
    }),
    note: text("note"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One first-deposit bonus per downline, ever. This is the guard that stops
    // a re-completed or duplicated deposit minting a second payout.
    unique("referral_bonuses_downline_key").on(t.downline_player_id),
  ],
);

// ---------- Rebate payouts ----------

export const rebatePayoutStatusEnum = pgEnum("rebate_payout_status", [
  "pending",
  "paid",
  "skipped",
]);

/**
 * One rebate owed to one player for one window of one plan — a snapshot of
 * what they lost between two cutoffs and the share the plan pays on it. Paid
 * as a free credit; the transfer/transaction ids point at that credit.
 */
export const rebatePayouts = pgTable(
  "rebate_payouts",
  {
    payout_id: serial("payout_id").primaryKey(),
    plan_id: integer("plan_id")
      .notNull()
      .references(() => bonusPlans.plan_id),
    player_id: integer("player_id")
      .notNull()
      .references(() => players.player_id),
    company_entity_id: integer("company_entity_id").references(() => entities.entity_id),
    period: bonusPeriodEnum("period").notNull(),
    // The window the loss was measured over: [window_start, window_end).
    window_start: timestamp("window_start", { withTimezone: true, mode: "string" }).notNull(),
    window_end: timestamp("window_end", { withTimezone: true, mode: "string" }).notNull(),
    deposits_total: numeric("deposits_total", { precision: 12, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    withdrawals_total: numeric("withdrawals_total", { precision: 12, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    // deposits_total − withdrawals_total, frozen at generate time.
    net_loss: numeric("net_loss", { precision: 12, scale: 2, mode: "number" }).notNull(),
    percentage: numeric("percentage", { precision: 5, scale: 2, mode: "number" }).notNull(),
    amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }).notNull(),
    status: rebatePayoutStatusEnum("status").notNull().default("pending"),
    // Where the credit goes — suggested at generate time, confirmed at pay time.
    game_name: varchar("game_name", { length: 60 }),
    game_username: varchar("game_username", { length: 120 }),
    // True when CS credited the game by hand; false = the agent was asked to.
    skip_bot: boolean("skip_bot").notNull().default(false),
    game_transfer_id: integer("game_transfer_id"),
    // The free-credit ledger row (transactions.game_topup) written at pay time.
    transaction_id: integer("transaction_id"),
    generated_by_user_id: integer("generated_by_user_id").references(() => users.user_id),
    generated_at: timestamp("generated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    paid_by_user_id: integer("paid_by_user_id").references(() => users.user_id),
    paid_at: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    note: text("note"),
  },
  (t) => [
    // One rebate per player per window per plan — the guard against a second
    // "generate" paying anyone twice.
    unique("rebate_payouts_plan_player_window_key").on(t.plan_id, t.player_id, t.window_start),
  ],
);

// ---------- Game credits ----------

export const gameCredits = pgTable(
  "game_credits",
  {
    player_id: integer("player_id")
      .notNull()
      .references(() => players.player_id),
    game_name: varchar("game_name", { length: 60 }).notNull(),
    // Which of the player's logins under this game the balance belongs to. A
    // player may hold several accounts on one game; each carries its own
    // balance. "" is the legacy/only-login row (backfilled from the player's
    // first linked account for the game).
    game_username: varchar("game_username", { length: 120 }).notNull().default(""),
    current_balance: numeric("current_balance", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    last_updated_at: timestamp("last_updated_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.player_id, t.game_name, t.game_username] })],
);

export const gameTransfers = pgTable("game_transfers", {
  transfer_id: serial("transfer_id").primaryKey(),
  player_id: integer("player_id")
    .notNull()
    .references(() => players.player_id),
  from_game: varchar("from_game", { length: 60 }).notNull(),
  to_game: varchar("to_game", { length: 60 }).notNull(),
  // Which specific logins the move is between. Null = the player's first
  // account for each game (the pre-multi-account default).
  from_game_username: varchar("from_game_username", { length: 120 }),
  to_game_username: varchar("to_game_username", { length: 120 }),
  transfer_amount: numeric("transfer_amount", {
    precision: 12,
    scale: 2,
    mode: "number",
  }).notNull(),
  from_game_balance_before: numeric("from_game_balance_before", {
    precision: 12,
    scale: 2,
    mode: "number",
  }).notNull(),
  // "Move the whole source wallet." game_credits is a cache that lags the
  // provider, so resolving "all" to a number at request time posts a stale
  // figure — the flag travels to the agent instead, which reads the real
  // balance and reports back what it actually moved. transfer_amount stays 0
  // until then. Mirrors withdrawals.withdraw_all.
  transfer_all: boolean("transfer_all").notNull().default(false),
  status: gameTransferStatusEnum("status").notNull().default("completed"),
  // Why a transfer ended the way it did — the agent's `note` on
  // PATCH /:id/status. Its reason for failing, most usefully.
  note: text("note"),
  // How many times the move has been attempted. 1 on the first try; the stuck-
  // transfer sweep bumps it each time it restarts a stalled transfer.
  attempt_count: integer("attempt_count").notNull().default(1),
  // Nullable: agent/system-initiated transfers have no human user.
  handled_by_user_id: integer("handled_by_user_id").references(
    () => users.user_id,
  ),
  // The CS agent who claimed this transfer ("Assign to me"), so two agents
  // don't work the same one. Independent of handled_by_user_id, which records
  // who actually created it.
  assigned_to_user_id: integer("assigned_to_user_id").references(
    () => users.user_id,
  ),
  assigned_at: timestamp("assigned_at", {
    withTimezone: true,
    mode: "string",
  }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  // When the transfer entered "processing" — the clock the agent is racing.
  // Null only for a transfer still sitting in "pending".
  started_at: timestamp("started_at", { withTimezone: true, mode: "string" }),
  // When it reached a terminal state (completed or failed). Null while in
  // flight; with started_at it gives the time the move actually took.
  completed_at: timestamp("completed_at", {
    withTimezone: true,
    mode: "string",
  }),
});

// ---------- Provider back-office ----------

export const providerBoAccounts = pgTable("provider_bo_accounts", {
  bo_account_id: serial("bo_account_id").primaryKey(),
  company_entity_id: integer("company_entity_id")
    .notNull()
    .references(() => entities.entity_id),
  game_name: varchar("game_name", { length: 60 }).notNull(),
  bo_username: varchar("bo_username", { length: 80 }).notNull(),
  // Back-office login URL — the agent fetches it from here, so a provider URL
  // change only needs a CRM edit, not an agent redeploy.
  bo_url: varchar("bo_url", { length: 300 }),
  // Back-office credentials the AI agent uses to log in and assign game credit.
  bo_password: varchar("bo_password", { length: 120 }),
  bo_pin: varchar("bo_pin", { length: 20 }),
  bo_label: varchar("bo_label", { length: 60 }),
  // Last time the AI agent pinged us for this kiosk (heartbeat/online status).
  last_heartbeat_at: timestamp("last_heartbeat_at", {
    withTimezone: true,
    mode: "string",
  }),
  current_credit: numeric("current_credit", {
    precision: 14,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  status: activeStatusEnum("status").notNull().default("active"),
  notes: text("notes"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export const providerBoAdjustments = pgTable("provider_bo_adjustments", {
  adjustment_id: serial("adjustment_id").primaryKey(),
  bo_account_id: integer("bo_account_id")
    .notNull()
    .references(() => providerBoAccounts.bo_account_id),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  handled_by_user_id: integer("handled_by_user_id")
    .notNull()
    .references(() => users.user_id),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

// ---------- Audit log ----------

export const transactions = pgTable("transactions", {
  transaction_id: serial("transaction_id").primaryKey(),
  player_id: integer("player_id").references(() => players.player_id),
  // Which entity the event belongs to: the player's company for player-scoped
  // events, or the acted-on bank account's entity for bank transfers.
  entity_id: integer("entity_id").references(() => entities.entity_id),
  type: auditTypeEnum("type").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  game_name: varchar("game_name", { length: 60 }),
  reference_id: integer("reference_id"),
  user_id: integer("user_id").references(() => users.user_id),
  details: jsonb("details").$type<Record<string, unknown>>(),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

// ---------- Expenses ----------

export const expenseCategoryEnum = pgEnum("expense_category", [
  "salary",
  "sim_card",
  "subscription",
  "rent",
  "utilities",
  "equipment",
  "marketing",
  "other",
]);

export const expenses = pgTable("expenses", {
  expense_id: serial("expense_id").primaryKey(),
  expense_date: timestamp("expense_date", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  category: expenseCategoryEnum("category").notNull(),
  description: varchar("description", { length: 200 }).notNull(),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  company_entity_id: integer("company_entity_id").references(
    () => entities.entity_id,
  ),
  recorded_by_user_id: integer("recorded_by_user_id")
    .notNull()
    .references(() => users.user_id),
  notes: text("notes"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

/**
 * A settlement between two leaders — one leader moving funds to another.
 *
 * Distinct from `expenses` (operational costs leaving the business) and from
 * `bankTransfers` (movement between bank accounts): this records an accounting
 * transfer between two leader entities, so leader-to-leader flow can be
 * reported without being tangled up in either.
 */
export const leaderTransfers = pgTable("leader_transfers", {
  transfer_id: serial("transfer_id").primaryKey(),
  from_leader_entity_id: integer("from_leader_entity_id")
    .notNull()
    .references(() => entities.entity_id),
  to_leader_entity_id: integer("to_leader_entity_id")
    .notNull()
    .references(() => entities.entity_id),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  // What the settlement is for — free text, shown in the list and report.
  note: text("note"),
  created_by_user_id: integer("created_by_user_id")
    .notNull()
    .references(() => users.user_id),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

// ---------- Agent health ----------

/**
 * Latest reported health per bot process. Bots POST /api/bot/heartbeat every
 * ~30s; one row per bot_id, newest heartbeat wins. `online` is derived (not
 * stored) from how recent `last_heartbeat_at` is.
 */
export const botHealth = pgTable("bot_health", {
  bot_id: varchar("bot_id", { length: 80 }).primaryKey(),
  state: botStateEnum("state").notNull(),
  step: varchar("step", { length: 120 }),
  error: text("error"),
  cycle: integer("cycle"),
  last_transaction_at: timestamp("last_transaction_at", {
    withTimezone: true,
    mode: "string",
  }),
  last_heartbeat_at: timestamp("last_heartbeat_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  first_seen: timestamp("first_seen", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

/**
 * The agent's live feed — what it is doing, as it does it.
 *
 * bot_health answers "is the bot up and what step is it on" as a single
 * overwritten row. This is the running narrative underneath it: one row per
 * event, kept so that when a transfer fails at 2am someone can read back what
 * the agent was doing at the time. Deliberately append-only and cheap to write —
 * the agent should be able to post freely without thinking about cost.
 *
 * Trimmed by the retention sweep; this is an operational log, not a ledger.
 */
export const botEvents = pgTable("bot_events", {
  event_id: serial("event_id").primaryKey(),
  bot_id: varchar("bot_id", { length: 80 }).notNull(),
  level: botEventLevelEnum("level").notNull().default("info"),
  // Short machine-readable tag, e.g. "transfer.claimed", "login.failed".
  event: varchar("event", { length: 80 }).notNull(),
  message: text("message"),
  // Whatever the agent wants to attach — screenshots, provider responses, timings.
  context: jsonb("context").$type<Record<string, unknown>>(),
  // Optional links back to the record this is about, so a feed can be filtered
  // down to one transfer/deposit/player.
  player_id: integer("player_id").references(() => players.player_id),
  game_transfer_id: integer("game_transfer_id"),
  deposit_id: integer("deposit_id"),
  withdrawal_id: integer("withdrawal_id"),
  // When the agent says it happened; may lag created_at if it batched the post.
  occurred_at: timestamp("occurred_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

/**
 * On-demand work the CRM has asked the agent to do — a queue of one-off jobs,
 * not a schedule.
 *
 * The agent already sweeps the banks on its own cycle. This table exists for
 * the moments that cycle is too slow: a player says "I've paid", CS presses
 * Crawl banks on the Deposits page, and the agent goes and looks now rather
 * than at the top of the next sweep.
 *
 * Deliberately shaped like `game_transfers`: the agent polls for `pending`,
 * claims one by moving it to `running`, then reports `completed`/`failed`.
 * Unlike a transfer, a command carries no money and nothing is reversed when
 * one fails — the worst case is that the sweep picks the transactions up a few
 * minutes later.
 */
export const botCommands = pgTable("bot_commands", {
  command_id: serial("command_id").primaryKey(),
  command: botCommandEnum("command").notNull(),
  status: botCommandStatusEnum("status").notNull().default("pending"),
  // Null = every active deposit account in scope. Set to crawl one account.
  bank_account_id: integer("bank_account_id").references(
    () => bankAccounts.account_id,
  ),
  // The company the request was made under, from the requester's scope. Null =
  // unscoped (a super admin with no company selected) — crawl everything.
  company_entity_id: integer("company_entity_id").references(
    () => entities.entity_id,
  ),
  // Null when the system queued it rather than a person.
  requested_by_user_id: integer("requested_by_user_id").references(
    () => users.user_id,
  ),
  // Which agent process claimed it, so a command stuck in "running" points at
  // the bot to go and look at.
  bot_id: varchar("bot_id", { length: 80 }),
  // Whatever the agent wants to report back: accounts crawled, transactions
  // seen, deposits created. Free-form so a new counter needs no migration.
  result: jsonb("result").$type<Record<string, unknown>>(),
  error: text("error"),
  // Past this, an unclaimed command is swept to "expired" — see the enum note.
  expires_at: timestamp("expires_at", { withTimezone: true, mode: "string" })
    .notNull(),
  claimed_at: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
  completed_at: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

// ---------- System log ----------

/** Which part of the system an action touched. Drives the log's filters. */
export const activityCategoryEnum = pgEnum("activity_category", [
  "auth",
  "user",
  "entity",
  "player",
  "bank_account",
  "kiosk",
  "bonus",
  "api_key",
  "settings",
  "expense",
  "other",
]);

/**
 * Who did what — everything the money ledger doesn't cover.
 *
 * `transactions` only records money moving; every row there joins a player and
 * carries an amount. That left the whole administrative surface unrecorded:
 * staff accounts, the entity tree, settings, bonuses, bank accounts, kiosks,
 * API keys, sign-ins. Those land here instead.
 *
 * The System Log page reads this alongside `transactions` and `bot_events`.
 * Each action is written to exactly one of the three — this is not a mirror of
 * the ledger, and nothing should be logged twice.
 */
export const activityLog = pgTable("activity_log", {
  log_id: serial("log_id").primaryKey(),
  occurred_at: timestamp("occurred_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  category: activityCategoryEnum("category").notNull(),
  // Machine tag, dotted: "bonus.updated", "auth.login_failed". Free text, not
  // an enum, so a new action never needs a migration to be loggable.
  action: varchar("action", { length: 60 }).notNull(),
  // The line a person reads, written in the words that were true at the time.
  summary: text("summary").notNull(),
  // Null when there is no user behind it: a rejected sign-in, or the system.
  actor_user_id: integer("actor_user_id").references(() => users.user_id),
  // The actor as plain text, for when the id can't carry it — the username
  // someone tried to sign in as, or an account since deleted.
  actor_label: varchar("actor_label", { length: 120 }),
  // Null = system-wide (settings, API keys); only the super admin sees those.
  company_entity_id: integer("company_entity_id").references(
    () => entities.entity_id,
  ),
  // What was acted on. Deliberately not a foreign key: the row may be deleted,
  // and the log has to outlive it.
  target_type: varchar("target_type", { length: 40 }),
  target_id: integer("target_id"),
  target_label: varchar("target_label", { length: 120 }),
  // Field-level diff for edits — an audit that only says "updated" answers
  // nothing. [{ field, from, to }].
  changes: jsonb("changes").$type<
    Array<{ field: string; from: unknown; to: unknown }>
  >(),
  // IP and user agent on sign-ins, counts on bulk actions, override reasons.
  context: jsonb("context").$type<Record<string, unknown>>(),
});

// ---------- Integration ----------

export const apiKeys = pgTable("api_keys", {
  key_id: serial("key_id").primaryKey(),
  key_hash: varchar("key_hash", { length: 64 }).notNull().unique(), // sha256 hex
  hint: varchar("hint", { length: 32 }), // display-only, e.g. "alpha_dbk…5ea0"
  label: varchar("label", { length: 80 }).notNull(),
  // When set, the key is scoped to this company: agent reads (bank accounts,
  // kiosks) only return that company's data. null = unscoped (full access).
  company_entity_id: integer("company_entity_id").references(
    () => entities.entity_id,
  ),
  // Optional IP allowlist; when non-empty, requests from other IPs are
  // rejected even with a valid key. Requires the agent to have a static egress IP.
  allowed_ips: jsonb("allowed_ips").$type<string[]>(),
  status: activeStatusEnum("status").notNull().default("active"),
  last_used_at: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export const settings = pgTable("settings", {
  key: varchar("key", { length: 60 }).primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

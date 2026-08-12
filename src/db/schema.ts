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
  username: varchar("username", { length: 60 }).notNull().unique(),
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

export const players = pgTable("players", {
  player_id: serial("player_id").primaryKey(),
  username: varchar("username", { length: 60 }).notNull().unique(),
  full_name: varchar("full_name", { length: 120 }).notNull(),
  contact_number: varchar("contact_number", { length: 40 }),
  telegram_username: varchar("telegram_username", { length: 80 }).notNull(),
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

export const deposits = pgTable("deposits", {
  deposit_id: serial("deposit_id").primaryKey(),
  // Agent idempotency key — the agent's own queue id, e.g.
  // "25_Jun_2026_Hello_TAN_KIEN_HUAT_*Fund_Transfer_2.0"
  external_id: varchar("external_id", { length: 200 }).unique(),
  transaction_ref: varchar("transaction_ref", { length: 80 }).notNull(),
  deposit_date: timestamp("deposit_date", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
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
  status: depositStatusEnum("status").notNull().default("pending"),
  // Agent-detected bank credits default to "agent"; CRM-entered deposits set "manual".
  source: transactionSourceEnum("source").notNull().default("bot"),
  // When true the deposit is fully manual: the agent never matches or tops it up;
  // a human approves → processing → completes (or rejects) it.
  skip_bot: boolean("skip_bot").notNull().default(false),
  matched_at: timestamp("matched_at", { withTimezone: true, mode: "string" }),
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
  requested_amount: numeric("requested_amount", {
    precision: 12,
    scale: 2,
    mode: "number",
  }).notNull(),
  game_name: varchar("game_name", { length: 60 }).notNull(),
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

// ---------- Game credits ----------

export const gameCredits = pgTable(
  "game_credits",
  {
    player_id: integer("player_id")
      .notNull()
      .references(() => players.player_id),
    game_name: varchar("game_name", { length: 60 }).notNull(),
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
  (t) => [primaryKey({ columns: [t.player_id, t.game_name] })],
);

export const gameTransfers = pgTable("game_transfers", {
  transfer_id: serial("transfer_id").primaryKey(),
  player_id: integer("player_id")
    .notNull()
    .references(() => players.player_id),
  from_game: varchar("from_game", { length: 60 }).notNull(),
  to_game: varchar("to_game", { length: 60 }).notNull(),
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

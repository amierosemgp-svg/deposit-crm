import {
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
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

/** Who created a transaction: the bot (auto-detected) or a person (manual). */
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

export const gameTransferStatusEnum = pgEnum("game_transfer_status", [
  "pending",
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
  // Online-banking credentials the AI bot uses to query the account.
  login_id: varchar("login_id", { length: 80 }),
  login_password: varchar("login_password", { length: 120 }),
  login_pin: varchar("login_pin", { length: 20 }),
  // Last time the AI bot pinged us for this account (heartbeat/online status).
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
  // Nullable: bot/system-initiated transfers have no human user.
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
  // Bot idempotency key — the bot's own queue id, e.g.
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
  // Bot-detected bank credits default to "bot"; CRM-entered deposits set "manual".
  source: transactionSourceEnum("source").notNull().default("bot"),
  matched_at: timestamp("matched_at", { withTimezone: true, mode: "string" }),
  handled_by_user_id: integer("handled_by_user_id").references(() => users.user_id),
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
  // CS-entered requests default to "manual"; bot-created requests set "bot".
  source: transactionSourceEnum("source").notNull().default("manual"),
  handled_by_user_id: integer("handled_by_user_id").references(() => users.user_id),
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
  // Nullable: bot/system-initiated transfers have no human user.
  handled_by_user_id: integer("handled_by_user_id").references(
    () => users.user_id,
  ),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

// ---------- Provider back-office ----------

export const providerBoAccounts = pgTable("provider_bo_accounts", {
  bo_account_id: serial("bo_account_id").primaryKey(),
  company_entity_id: integer("company_entity_id")
    .notNull()
    .references(() => entities.entity_id),
  game_name: varchar("game_name", { length: 60 }).notNull(),
  bo_username: varchar("bo_username", { length: 80 }).notNull(),
  // Back-office credentials the AI bot uses to log in and assign game credit.
  bo_password: varchar("bo_password", { length: 120 }),
  bo_pin: varchar("bo_pin", { length: 20 }),
  bo_label: varchar("bo_label", { length: 60 }),
  // Last time the AI bot pinged us for this kiosk (heartbeat/online status).
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

// ---------- Bot health ----------

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

// ---------- Integration ----------

export const apiKeys = pgTable("api_keys", {
  key_id: serial("key_id").primaryKey(),
  key_hash: varchar("key_hash", { length: 64 }).notNull().unique(), // sha256 hex
  hint: varchar("hint", { length: 24 }), // display-only, e.g. "dbk_48d8…5ea0"
  label: varchar("label", { length: 80 }).notNull(),
  // Optional IP allowlist; when non-empty, requests from other IPs are
  // rejected even with a valid key. Requires the bot to have a static egress IP.
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

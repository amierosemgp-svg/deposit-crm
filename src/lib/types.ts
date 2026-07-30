// Shapes mirror the API/DB (see src/db/schema.ts).

export type UserRole = "super_admin" | "company_leader" | "cs_agent" | "viewer";

export type EntityType = "main_company" | "leader" | "company" | "cs";

export type Entity = {
  entity_id: number;
  parent_entity_id: number | null;
  entity_type: EntityType;
  name: string;
  status: "active" | "inactive";
  created_at: string;
};

export type User = {
  user_id: number;
  username: string;
  full_name: string;
  email?: string;
  role: UserRole;
  entity_id: number;
  status: "active" | "inactive";
  last_login_at: string | null;
  created_at: string;
};

export type Me = User & {
  companyIds: number[] | null; // null = unrestricted
  ownedEntityIds: number[] | null;
};

/** Derived view over company entities — convenient for dropdowns/filters. */
export type CompanyView = {
  company_id: number; // entity_id of the company
  company_name: string;
  leader_entity_id: number | null;
  leader_name: string;
  status: "active" | "inactive";
};

// Games & banks come from server settings; these are fallbacks.
export type GameName = string;
export const GAMES: string[] = ["Mega888", "Pussy888", "918Kiss", "XE88"];
export type BankName = string;
export const BANKS: string[] = [
  "Maybank",
  "CIMB",
  "Hong Leong",
  "Public Bank",
  "RHB",
  "BSN",
  "Ambank",
];
export const BONUS_OPTIONS = [0, 5, 10, 20, 30, 50, 100] as const;

export type PlayerBankAccount = {
  bank_name: string;
  account_number: string;
  account_holder: string;
};

export type PlayerGameAccount = {
  game_name: string;
  game_username: string;
};

export type Player = {
  player_id: number;
  username: string;
  full_name: string;
  contact_number?: string | null;
  telegram_username: string;
  wechat_id?: string | null;
  company_entity_id: number;
  bank_accounts?: PlayerBankAccount[] | null;
  game_accounts?: PlayerGameAccount[] | null;
  registration_date: string;
  status: "active" | "suspended";
  total_deposits: number;
  total_withdrawals: number;
  notes?: string | null;
};

export type DepositStatus =
  | "pending_match"
  | "matched"
  | "pending"
  | "approved"
  | "processing"
  | "completed"
  | "failed";

/** Who created a transaction: the bot (auto) or a person (manual). */
export type TransactionSource = "bot" | "manual";

/** A kiosk/account counts as online if pinged within this window. */
export const HEARTBEAT_ONLINE_MS = 5 * 60 * 1000;

export type BotState =
  | "starting"
  | "working"
  | "idle"
  | "stuck"
  | "error"
  | "maintenance"
  | "stopped";

export type BotHealth = {
  bot_id: string;
  state: BotState;
  step?: string | null;
  error?: string | null;
  cycle?: number | null;
  last_transaction_at?: string | null;
  last_heartbeat_at: string;
  first_seen: string;
  updated_at: string;
};

/** A bot counts as online if it pinged within this window (spec: 90s). */
export const BOT_ONLINE_MS = 90 * 1000;

export type Deposit = {
  deposit_id: number;
  external_id?: string | null;
  transaction_ref: string;
  deposit_date: string;
  player_id: number | null;
  player_username: string | null;
  company_entity_id: number | null;
  deposit_amount: number;
  bank_name: string;
  bank_account_number?: string | null;
  bank_account_holder?: string | null;
  bank_description?: string | null;
  received_into_account_id?: number | null;
  bonus_percentage: number;
  bonus_amount: number;
  total_amount: number;
  selected_game: string | null;
  status: DepositStatus;
  source?: TransactionSource;
  skip_bot?: boolean;
  matched_at?: string | null;
  handled_by_user_id?: number | null;
  /** The CS agent who claimed it. Null until someone assigns it. */
  assigned_to_user_id?: number | null;
  assigned_at?: string | null;
  game_topup_reference?: string | null;
  receipt_url?: string | null;
  created_at: string;
  updated_at: string;
  is_new?: boolean; // client-side: arrived since the previous poll
};

export type WithdrawalStatus = "requested" | "credits_pulled" | "paid" | "failed";

export type Withdrawal = {
  withdrawal_id: number;
  player_id: number;
  requested_amount: number;
  game_name: string;
  credit_pulled_amount: number;
  status: WithdrawalStatus;
  source?: TransactionSource;
  skip_bot?: boolean;
  handled_by_user_id?: number | null;
  /** The CS agent who claimed it. Null until someone assigns it. */
  assigned_to_user_id?: number | null;
  assigned_at?: string | null;
  bank_name?: string | null;
  bank_account_number?: string | null;
  paid_from_account_id?: number | null;
  proof_url?: string | null;
  paid_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type GameTransferStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

/** A transfer the bot hasn't reported back on within this window is stuck. */
export const STUCK_TRANSFER_MS = 5 * 60 * 1000;
/** How many times a stalled transfer is restarted before we give up on it. */
export const MAX_TRANSFER_ATTEMPTS = 3;

export type GameTransfer = {
  transfer_id: number;
  player_id: number;
  from_game: string;
  to_game: string;
  transfer_amount: number;
  from_game_balance_before: number;
  status: GameTransferStatus;
  /** The bot's reason for the outcome — why it failed, when it failed. */
  note: string | null;
  /** 1 on the first try; bumped each time the stuck-transfer sweep restarts it. */
  attempt_count: number;
  handled_by_user_id: number;
  /** The CS agent who claimed it. Null until someone assigns it. */
  assigned_to_user_id: number | null;
  assigned_at: string | null;
  created_at: string;
  /** Entered "processing". Null only while still "pending". */
  started_at: string | null;
  /** Reached "completed" or "failed". Null while in flight. */
  completed_at: string | null;
};

export type GameCredit = {
  player_id: number;
  game_name: string;
  current_balance: number;
  last_updated_at: string;
};

export type BankAccountRole = "deposit" | "withdrawal";

export type BankAccount = {
  account_id: number;
  entity_id: number;
  role: BankAccountRole;
  bank_name: string;
  account_number: string;
  account_holder: string;
  label?: string | null;
  login_id?: string | null;
  login_password?: string | null;
  login_pin?: string | null;
  last_heartbeat_at?: string | null;
  current_balance: number;
  status: "active" | "inactive";
  created_at: string;
};

export type BankTransferStatus =
  | "pending_confirmation"
  | "confirmed"
  | "auto_confirmed"
  | "rejected"
  | "failed";

export type BankTransfer = {
  transfer_id: number;
  from_account_id: number;
  to_account_id: number;
  amount: number;
  reference?: string | null;
  notes?: string | null;
  status: BankTransferStatus;
  skip_bot?: boolean;
  initiated_by_user_id: number;
  confirmed_by_user_id?: number | null;
  confirmed_at?: string | null;
  expires_at?: string | null;
  created_at: string;
};

export type ProviderBoAccount = {
  bo_account_id: number;
  company_entity_id: number;
  game_name: string;
  bo_username: string;
  bo_url?: string | null;
  bo_password?: string | null;
  bo_pin?: string | null;
  bo_label?: string | null;
  last_heartbeat_at?: string | null;
  current_credit: number;
  status: "active" | "inactive";
  notes?: string | null;
  created_at: string;
};

export type ProviderBoAdjustment = {
  adjustment_id: number;
  bo_account_id: number;
  amount: number;
  reason: string;
  handled_by_user_id: number;
  created_at: string;
};

export type AuditEntry = {
  transaction_id: number;
  player_id: number | null;
  entity_id: number | null;
  type:
    | "deposit"
    | "withdrawal"
    | "game_topup"
    | "game_transfer"
    | "credit_pull"
    | "bank_transfer"
    | "bo_adjustment"
    | "player_import";
  amount: number;
  game_name?: string | null;
  reference_id?: number | null;
  user_id?: number | null;
  details?: Record<string, unknown> | null;
  created_at: string;
};

export type ApiKeyRow = {
  key_id: number;
  label: string;
  hint: string | null;
  status: "active" | "inactive";
  allowed_ips: string[] | null;
  company_entity_id: number | null;
  last_used_at?: string | null;
  created_at: string;
};

export const EXPENSE_CATEGORIES = [
  "salary",
  "sim_card",
  "subscription",
  "rent",
  "utilities",
  "equipment",
  "marketing",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export type Expense = {
  expense_id: number;
  expense_date: string;
  category: ExpenseCategory;
  description: string;
  amount: number;
  company_entity_id: number | null;
  recorded_by_user_id: number;
  notes?: string | null;
  created_at: string;
};

export type ServerSettings = {
  transfer_auto_confirm_hours?: number;
  bonus_options?: number[];
  games?: string[];
  banks?: string[];
  [key: string]: unknown;
};

// Legacy aliases kept so existing components compile during migration.
export type CompanyBankAccount = BankAccount;
export type Organization = { org_id: number; org_name: string };
export type Company = CompanyView;

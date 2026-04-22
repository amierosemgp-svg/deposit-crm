export type UserRole = "super_admin" | "company_leader" | "cs_agent" | "viewer";

export type User = {
  user_id: number;
  username: string;
  full_name: string;
  email: string;
  role: UserRole;
  company_id?: number;
  status: "active" | "inactive";
  last_login_at: string;
  created_at: string;
};

export type Organization = {
  org_id: number;
  org_name: string;
};

export type Company = {
  company_id: number;
  org_id: number;
  company_name: string;
  leader_user_id: number;
  status: "active" | "inactive";
};

export type GameName = "Mega888" | "Pussy888" | "918Kiss" | "XE88";
export const GAMES: GameName[] = ["Mega888", "Pussy888", "918Kiss", "XE88"];

export type BankName = "Maybank" | "CIMB" | "Hong Leong" | "Public Bank";
export const BANKS: BankName[] = ["Maybank", "CIMB", "Hong Leong", "Public Bank"];

export type PlayerBankAccount = {
  bank_name: BankName;
  account_number: string;
  account_holder: string;
};

export type PlayerGameAccount = {
  game_name: GameName;
  game_username: string;
};

export type Player = {
  player_id: number;
  username: string;
  full_name: string;
  contact_number?: string;
  telegram_username: string;
  wechat_id?: string;
  company_id: number;
  bank_accounts?: PlayerBankAccount[];
  game_accounts?: PlayerGameAccount[];
  registration_date: string;
  status: "active" | "suspended";
  total_deposits: number;
  total_withdrawals: number;
  notes?: string;
};

export type DepositStatus =
  | "pending"
  | "approved"
  | "processing"
  | "completed"
  | "failed";

export type Deposit = {
  deposit_id: number;
  transaction_ref: string;
  deposit_date: string;
  player_id: number;
  player_username: string;
  deposit_amount: number;
  bank_name: BankName;
  bank_account_number: string;
  bank_account_holder: string;
  bonus_percentage: number;
  bonus_amount: number;
  total_amount: number;
  selected_game: GameName | null;
  status: DepositStatus;
  handled_by_user_id?: number;
  game_topup_reference?: string;
  created_at: string;
  updated_at: string;
  is_new?: boolean;
};

export type WithdrawalStatus =
  | "requested"
  | "credits_pulled"
  | "paid"
  | "failed";

export type Withdrawal = {
  withdrawal_id: number;
  player_id: number;
  requested_amount: number;
  game_name: GameName;
  credit_pulled_amount: number;
  status: WithdrawalStatus;
  handled_by_user_id?: number;
  created_at: string;
  updated_at: string;
};

export type GameTransferStatus = "pending" | "completed" | "failed";

export type GameTransfer = {
  transfer_id: number;
  player_id: number;
  from_game: GameName;
  to_game: GameName;
  transfer_amount: number;
  from_game_balance_before: number;
  status: GameTransferStatus;
  handled_by_user_id: number;
  created_at: string;
};

export type GameCredit = {
  player_id: number;
  game_name: GameName;
  current_balance: number;
  last_updated_at: string;
};

export type CompanyBankAccount = {
  account_id: number;
  company_id: number;
  bank_name: BankName;
  account_number: string;
  account_holder: string;
  label?: string;
  current_balance: number;
  status: "active" | "inactive";
  created_at: string;
};

export type BankTransferStatus = "completed" | "failed";

export type BankTransfer = {
  transfer_id: number;
  from_account_id: number;
  to_account_id: number;
  amount: number;
  reference?: string;
  notes?: string;
  handled_by_user_id: number;
  status: BankTransferStatus;
  created_at: string;
};

export type ProviderBoAccount = {
  bo_account_id: number;
  company_id: number;
  game_name: GameName;
  bo_username: string;
  bo_label?: string;
  current_credit: number;
  status: "active" | "inactive";
  notes?: string;
  created_at: string;
};

export type ProviderBoAdjustment = {
  adjustment_id: number;
  bo_account_id: number;
  amount: number; // positive = top-up from provider, negative = manual deduction
  reason: string;
  handled_by_user_id: number;
  created_at: string;
};

export const BONUS_OPTIONS = [0, 5, 10, 20, 30, 50, 100] as const;

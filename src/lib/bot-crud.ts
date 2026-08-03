/* Shared helpers for the bot CRUD endpoints (/api/bot/*).
 * Bot requests authenticate with an API key and act system-wide — there is no
 * per-request role scope, unlike the human/session API. */
import type {
  bankAccounts,
  bankTransfers,
  entities,
  gameCredits,
  gameTransfers,
  players,
  providerBoAccounts,
  withdrawals,
} from "@/db/schema";

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

/** Thrown inside a bot handler to abort with a specific status (rolls back any open txn). */
export class BotError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Maps a thrown BotError to a JSON response; returns null for anything else. */
export function botErrorResponse(e: unknown): Response | null {
  if (e instanceof BotError) return jsonError(e.message, e.status);
  return null;
}

/** True when a Postgres error is a foreign-key violation (row still referenced). */
export function isFkViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "23503"
  );
}

/** True when a unique constraint was violated. */
export function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "23505"
  );
}

export function playerJson(p: typeof players.$inferSelect) {
  return {
    player_id: p.player_id,
    username: p.username,
    full_name: p.full_name,
    contact_number: p.contact_number,
    telegram_username: p.telegram_username,
    wechat_id: p.wechat_id,
    company_entity_id: p.company_entity_id,
    bank_accounts: p.bank_accounts,
    game_accounts: p.game_accounts,
    status: p.status,
    total_deposits: p.total_deposits,
    total_withdrawals: p.total_withdrawals,
    notes: p.notes,
    registration_date: p.registration_date,
  };
}

export function entityJson(e: typeof entities.$inferSelect) {
  return {
    entity_id: e.entity_id,
    parent_entity_id: e.parent_entity_id,
    entity_type: e.entity_type,
    name: e.name,
    status: e.status,
    created_at: e.created_at,
  };
}

export function bankAccountJson(a: typeof bankAccounts.$inferSelect) {
  return {
    account_id: a.account_id,
    entity_id: a.entity_id,
    role: a.role,
    bank_name: a.bank_name,
    account_number: a.account_number,
    account_holder: a.account_holder,
    label: a.label,
    // Online-banking login the bot uses to query the account. Named to match
    // the kiosk endpoint (username/password/pin); login_* kept as aliases.
    username: a.login_id,
    password: a.login_password,
    pin: a.login_pin,
    login_id: a.login_id,
    login_password: a.login_password,
    login_pin: a.login_pin,
    // The device this account's banking app is bound to.
    device_id: a.device_id,
    last_heartbeat_at: a.last_heartbeat_at,
    current_balance: a.current_balance,
    status: a.status,
    created_at: a.created_at,
  };
}

export function kioskJson(k: typeof providerBoAccounts.$inferSelect) {
  return {
    kiosk_id: k.bo_account_id,
    company_entity_id: k.company_entity_id,
    game_name: k.game_name,
    url: k.bo_url,
    username: k.bo_username,
    password: k.bo_password,
    pin: k.bo_pin,
    label: k.bo_label,
    last_heartbeat_at: k.last_heartbeat_at,
    current_credit: k.current_credit,
    status: k.status,
    notes: k.notes,
    created_at: k.created_at,
  };
}

export function withdrawalJson(w: typeof withdrawals.$inferSelect) {
  return {
    type: "withdrawal" as const,
    id: w.withdrawal_id,
    withdrawal_id: w.withdrawal_id,
    player_id: w.player_id,
    requested_amount: w.requested_amount,
    game_name: w.game_name,
    credit_pulled_amount: w.credit_pulled_amount,
    status: w.status,
    bank_name: w.bank_name,
    bank_account_number: w.bank_account_number,
    paid_from_account_id: w.paid_from_account_id,
    proof_url: w.proof_url,
    paid_at: w.paid_at,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

export function gameCreditJson(c: typeof gameCredits.$inferSelect) {
  return {
    player_id: c.player_id,
    game_name: c.game_name,
    current_balance: c.current_balance,
    last_updated_at: c.last_updated_at,
  };
}

export function gameTransferJson(
  t: typeof gameTransfers.$inferSelect,
  // The player's game_accounts, so we can surface which in-game account to move
  // credits between (the player's login/ID in from_game and to_game).
  player?: {
    game_accounts: Array<{ game_name: string; game_username: string }> | null;
  } | null,
) {
  const accts = player?.game_accounts ?? null;
  return {
    type: "game_transfer" as const,
    id: t.transfer_id,
    transfer_id: t.transfer_id,
    player_id: t.player_id,
    from_game: t.from_game,
    to_game: t.to_game,
    // The player's account id/login in each game — what you move credits
    // between in the provider back-office. null if not recorded for that game.
    from_game_username:
      accts?.find((g) => g.game_name === t.from_game)?.game_username ?? null,
    to_game_username:
      accts?.find((g) => g.game_name === t.to_game)?.game_username ?? null,
    transfer_amount: t.transfer_amount,
    from_game_balance_before: t.from_game_balance_before,
    status: t.status,
    // Why it ended this way — the reason it failed, when it failed.
    note: t.note,
    created_at: t.created_at,
    started_at: t.started_at,
    completed_at: t.completed_at,
  };
}

export function bankTransferJson(t: typeof bankTransfers.$inferSelect) {
  return {
    type: "transfer" as const,
    id: t.transfer_id,
    transfer_id: t.transfer_id,
    from_account_id: t.from_account_id,
    to_account_id: t.to_account_id,
    amount: t.amount,
    reference: t.reference,
    notes: t.notes,
    status: t.status,
    initiated_by_user_id: t.initiated_by_user_id,
    confirmed_by_user_id: t.confirmed_by_user_id,
    confirmed_at: t.confirmed_at,
    expires_at: t.expires_at,
    created_at: t.created_at,
  };
}

/** A cs/leader/company entity may parent only specific child types. */
export const VALID_PARENT: Record<string, string> = {
  leader: "main_company",
  company: "leader",
  cs: "company",
};

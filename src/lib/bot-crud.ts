/* Shared helpers for the bot CRUD endpoints (/api/bot/*).
 * Bot requests authenticate with an API key and act system-wide — there is no
 * per-request role scope, unlike the human/session API. */
import type { bankAccounts, entities, players } from "@/db/schema";

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
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
    current_balance: a.current_balance,
    status: a.status,
    created_at: a.created_at,
  };
}

/** A cs/leader/company entity may parent only specific child types. */
export const VALID_PARENT: Record<string, string> = {
  leader: "main_company",
  company: "leader",
  cs: "company",
};

import { eq, ilike, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  bankAccounts,
  deposits,
  players,
  transactions,
  withdrawals,
} from "@/db/schema";

/** The agent's native transaction shape (see sources/transaction_queue.json). */
export type BotTransactionInput = {
  external_id?: string;
  bank: string;
  date?: string; // "25 Jun 2026" | "Today"
  description?: string;
  amount: number;
  type?: string; // "credit"
  raw_amount?: string;
  extracted_at?: string;
  account_number?: string; // receiving (company) account, if the bot knows it
  telegram_username?: string; // if the bot already knows the player
  receipt_url?: string;
  company_entity_id?: number; // which company the deposit belongs to, if the bot knows
};

export function parseBotDate(date?: string, extractedAt?: string): string {
  if (date && date.toLowerCase() !== "today") {
    const parsed = new Date(date);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (extractedAt) {
    const parsed = new Date(extractedAt);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/** Try to identify the player from the bank description (e.g. "MBB CT- TAN KIEN HUAT *Fund Transfer"). */
export async function matchPlayerByDescription(description?: string) {
  if (!description) return null;
  const upper = description.toUpperCase();
  const all = await db
    .select({
      player_id: players.player_id,
      username: players.username,
      full_name: players.full_name,
      company_entity_id: players.company_entity_id,
    })
    .from(players);
  return (
    all.find((p) => upper.includes(p.full_name.toUpperCase())) ?? null
  );
}

export async function findPlayerByTelegram(telegram?: string) {
  if (!telegram) return null;
  const handle = telegram.startsWith("@") ? telegram : `@${telegram}`;
  const [p] = await db
    .select({
      player_id: players.player_id,
      username: players.username,
      full_name: players.full_name,
      company_entity_id: players.company_entity_id,
    })
    .from(players)
    .where(ilike(players.telegram_username, handle));
  return p ?? null;
}

/** Resolve which company bank account received the money. */
export async function resolveReceivingAccount(input: BotTransactionInput) {
  if (input.account_number) {
    const normalized = input.account_number.replace(/\s+/g, "");
    const all = await db.select().from(bankAccounts);
    const byNumber = all.find(
      (a) => a.account_number.replace(/\s+/g, "") === normalized,
    );
    if (byNumber) return byNumber;
  }
  const byBank = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.bank_name, input.bank));
  // When the agent states the entity, only that entity's accounts qualify —
  // falling back to another company's account would misattribute the deposit.
  const pool = input.company_entity_id
    ? byBank.filter((a) => a.entity_id === input.company_entity_id)
    : byBank;
  return pool.find((a) => a.role === "deposit") ?? pool[0] ?? null;
}

/** Minimal player fields the agent needs to perform the top-up in the provider. */
export type PlayerGameInfo = {
  player_id: number;
  telegram_username: string;
  game_accounts: Array<{ game_name: string; game_username: string }> | null;
};

/**
 * Fetch the game-account info for the players referenced by a set of deposits,
 * keyed by player_id. Used to enrich the agent's transaction responses with the
 * player's in-game account id for the selected game.
 */
export async function playerGameInfoMap(
  playerIds: Array<number | null>,
): Promise<Map<number, PlayerGameInfo>> {
  const ids = [...new Set(playerIds.filter((x): x is number => x != null))];
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      player_id: players.player_id,
      telegram_username: players.telegram_username,
      game_accounts: players.game_accounts,
    })
    .from(players)
    .where(inArray(players.player_id, ids));
  return new Map(rows.map((r) => [r.player_id, r]));
}

export function depositToBotJson(
  d: typeof deposits.$inferSelect,
  player?: PlayerGameInfo | null,
) {
  // Resolve the player's account id in the selected game, so the agent knows
  // exactly which in-game account to top up (not just the CRM player id).
  const gameAccounts = player?.game_accounts ?? null;
  const match =
    d.selected_game && gameAccounts
      ? (gameAccounts.find((g) => g.game_name === d.selected_game) ?? null)
      : null;

  return {
    type: "deposit" as const,
    id: d.deposit_id,
    external_id: d.external_id,
    transaction_ref: d.transaction_ref,
    status: d.status,
    deposit_date: d.deposit_date,
    player_id: d.player_id,
    player_username: d.player_username,
    telegram_username: player?.telegram_username ?? null,
    amount: d.deposit_amount,
    bank: d.bank_name,
    bank_description: d.bank_description,
    bonus_percentage: d.bonus_percentage,
    total_amount: d.total_amount,
    selected_game: d.selected_game,
    // The player's login/ID in `selected_game` — what the agent tops up.
    game_username: match?.game_username ?? null,
    // Full list of the player's game accounts, for reference.
    game_accounts: gameAccounts,
    game_topup_reference: d.game_topup_reference,
    matched_at: d.matched_at,
    receipt_url: d.receipt_url,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

/** A withdrawal request created via the agent API. */
export type BotWithdrawalInput = {
  player_id: number;
  requested_amount: number;
  game_name: string;
  bank_name?: string;
  bank_account_number?: string;
};

/**
 * Create a withdrawal request (starts as "requested") and write the matching
 * audit-log entry. Shared by the merged /api/bot/transactions POST handler.
 */
export async function createBotWithdrawal(
  input: BotWithdrawalInput,
  meta: { apiKeyLabel?: string },
): Promise<
  | { ok: true; withdrawal: typeof withdrawals.$inferSelect }
  | { ok: false; status: number; error: string }
> {
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.player_id, input.player_id));
  if (!player) return { ok: false, status: 404, error: "Player not found" };

  const [created] = await db
    .insert(withdrawals)
    .values({
      player_id: input.player_id,
      requested_amount: input.requested_amount,
      game_name: input.game_name,
      bank_name: input.bank_name,
      bank_account_number: input.bank_account_number,
      source: "bot",
    })
    .returning();

  await db.insert(transactions).values({
    player_id: input.player_id,
    entity_id: player.company_entity_id,
    type: "withdrawal",
    amount: input.requested_amount,
    game_name: input.game_name,
    reference_id: created.withdrawal_id,
    details: {
      action: "requested",
      source: "bot",
      api_key_label: meta.apiKeyLabel ?? null,
    },
  });

  return { ok: true, withdrawal: created };
}

import { eq, ilike } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, deposits, players } from "@/db/schema";

/** The bot's native transaction shape (see sources/transaction_queue.json). */
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
  const [byBank] = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.bank_name, input.bank));
  return byBank?.role === "deposit" ? byBank : (byBank ?? null);
}

export function depositToBotJson(d: typeof deposits.$inferSelect) {
  return {
    id: d.deposit_id,
    external_id: d.external_id,
    transaction_ref: d.transaction_ref,
    status: d.status,
    deposit_date: d.deposit_date,
    player_id: d.player_id,
    player_username: d.player_username,
    amount: d.deposit_amount,
    bank: d.bank_name,
    bank_description: d.bank_description,
    bonus_percentage: d.bonus_percentage,
    total_amount: d.total_amount,
    selected_game: d.selected_game,
    matched_at: d.matched_at,
    receipt_url: d.receipt_url,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

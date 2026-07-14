import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, transactions } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import {
  depositToBotJson,
  findPlayerByTelegram,
  matchPlayerByDescription,
  parseBotDate,
  resolveReceivingAccount,
  type BotTransactionInput,
} from "@/lib/bot-transactions";

const DEPOSIT_STATUSES = [
  "pending_match",
  "matched",
  "pending",
  "approved",
  "processing",
  "completed",
  "failed",
] as const;

/**
 * GET /api/bot/transactions?status=pending_match&limit=50
 * Bot use-case #1: fetch transactions waiting for a bank match
 * (or any other status the bot wants to inspect).
 */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

  const statuses = statusParam
    ? (statusParam.split(",") as (typeof DEPOSIT_STATUSES)[number][]).filter(
        (s) => DEPOSIT_STATUSES.includes(s),
      )
    : ["pending_match" as const];

  if (!statuses.length) {
    return Response.json(
      { error: `Invalid status. Use: ${DEPOSIT_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  const rows = await db
    .select()
    .from(deposits)
    .where(inArray(deposits.status, statuses))
    .orderBy(desc(deposits.created_at))
    .limit(limit);

  return Response.json({
    count: rows.length,
    transactions: rows.map(depositToBotJson),
  });
}

const createSchema = z.object({
  // Accept both our field names and the bot's queue-item shape
  id: z.string().optional(),
  external_id: z.string().optional(),
  transaction: z
    .object({
      bank: z.string(),
      date: z.string().optional(),
      description: z.string().optional(),
      amount: z.number(),
      type: z.string().optional(),
      raw_amount: z.string().optional(),
      extracted_at: z.string().optional(),
    })
    .optional(),
  bank: z.string().optional(),
  date: z.string().optional(),
  description: z.string().optional(),
  amount: z.number().optional(),
  type: z.string().optional(),
  raw_amount: z.string().optional(),
  extracted_at: z.string().optional(),
  account_number: z.string().optional(),
  telegram_username: z.string().optional(),
  receipt_url: z.string().url().optional(),
});

/**
 * POST /api/bot/transactions
 * Bot use-case #5: create a transaction from a detected bank credit.
 * Idempotent on external_id — re-sending the same queue item returns the
 * existing row (200) instead of creating a duplicate (201).
 */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const raw = parsed.data;
  const tx = raw.transaction;
  const input: BotTransactionInput = {
    external_id: raw.external_id ?? raw.id,
    bank: tx?.bank ?? raw.bank ?? "",
    date: tx?.date ?? raw.date,
    description: tx?.description ?? raw.description,
    amount: tx?.amount ?? raw.amount ?? 0,
    type: tx?.type ?? raw.type,
    raw_amount: tx?.raw_amount ?? raw.raw_amount,
    extracted_at: tx?.extracted_at ?? raw.extracted_at,
    account_number: raw.account_number,
    telegram_username: raw.telegram_username,
    receipt_url: raw.receipt_url,
  };

  if (!input.bank || !input.amount || input.amount <= 0) {
    return Response.json(
      { error: "bank and a positive amount are required" },
      { status: 400 },
    );
  }
  if (input.type && input.type !== "credit") {
    return Response.json(
      { error: `Only credit transactions are accepted (got "${input.type}")` },
      { status: 422 },
    );
  }

  // Idempotency
  if (input.external_id) {
    const [existing] = await db
      .select()
      .from(deposits)
      .where(eq(deposits.external_id, input.external_id));
    if (existing) {
      return Response.json(
        { duplicate: true, transaction: depositToBotJson(existing) },
        { status: 200 },
      );
    }
  }

  const player =
    (await findPlayerByTelegram(input.telegram_username)) ??
    (await matchPlayerByDescription(input.description));
  const account = await resolveReceivingAccount(input);

  const nowIso = new Date().toISOString();
  const [created] = await db
    .insert(deposits)
    .values({
      external_id: input.external_id,
      transaction_ref: input.external_id
        ? `BOT-${input.external_id.slice(0, 60)}`
        : `BOT-${Date.now()}`,
      deposit_date: parseBotDate(input.date, input.extracted_at),
      player_id: player?.player_id ?? null,
      player_username: player?.username ?? null,
      company_entity_id: player?.company_entity_id ?? account?.entity_id ?? null,
      deposit_amount: input.amount,
      bank_name: input.bank,
      bank_description: input.description,
      received_into_account_id: account?.account_id ?? null,
      total_amount: input.amount,
      status: "pending",
      receipt_url: input.receipt_url,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .returning();

  await db.insert(transactions).values({
    player_id: player?.player_id ?? null,
    type: "deposit",
    amount: input.amount,
    reference_id: created.deposit_id,
    details: {
      source: "bot",
      api_key_label: auth.label,
      external_id: input.external_id,
      description: input.description,
      matched_player: player?.username ?? null,
    },
  });

  return Response.json(
    { transaction: depositToBotJson(created) },
    { status: 201 },
  );
}

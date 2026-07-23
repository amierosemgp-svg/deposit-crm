import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, transactions, withdrawals } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { withdrawalJson } from "@/lib/bot-crud";
import {
  createBotWithdrawal,
  depositToBotJson,
  findPlayerByTelegram,
  matchPlayerByDescription,
  parseBotDate,
  playerGameInfoMap,
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

const WITHDRAWAL_STATUSES = [
  "requested",
  "credits_pulled",
  "paid",
  "failed",
] as const;

/**
 * GET /api/bot/transactions?type=deposit|withdrawal|all&status=...&limit=50
 *
 * Deposits and withdrawals live in separate tables but are exposed here as one
 * transaction stream. Every item carries a `type` ("deposit" | "withdrawal").
 *   - type=deposit (default): deposits; status defaults to pending_match.
 *   - type=withdrawal: withdrawal requests.
 *   - type=all: both, merged and sorted newest-first.
 * `status` accepts a comma list; values are matched against whichever type(s)
 * they're valid for.
 */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const type = (url.searchParams.get("type") ?? "deposit").toLowerCase();
  const statusParam = url.searchParams.get("status");
  // Filter to a single game (deposit.selected_game / withdrawal.game_name),
  // e.g. ?game=Mega888. Accepts `game` or `selected_game`.
  const game =
    url.searchParams.get("game") ?? url.searchParams.get("selected_game");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

  if (!["deposit", "withdrawal", "all"].includes(type)) {
    return Response.json(
      { error: "Invalid type. Use: deposit, withdrawal, all" },
      { status: 400 },
    );
  }

  const wantDeposits = type === "deposit" || type === "all";
  const wantWithdrawals = type === "withdrawal" || type === "all";
  const statusList = statusParam
    ? statusParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const items: Array<
    ReturnType<typeof depositToBotJson> | ReturnType<typeof withdrawalJson>
  > = [];

  if (wantDeposits) {
    const valid = statusList
      ? statusList.filter((s) =>
          (DEPOSIT_STATUSES as readonly string[]).includes(s),
        )
      : null;
    // Backward compat: a pure deposit query with a bad status is a 400.
    if (type === "deposit" && statusList && valid && valid.length === 0) {
      return Response.json(
        { error: `Invalid status. Use: ${DEPOSIT_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }
    // No status given: default to pending_match for a pure deposit query,
    // otherwise (type=all) return every status.
    const statuses = valid ?? (type === "deposit" ? ["pending_match"] : null);
    if (!(statusList && statuses && statuses.length === 0)) {
      const conds: SQL[] = [];
      if (statuses) {
        conds.push(
          inArray(
            deposits.status,
            statuses as (typeof DEPOSIT_STATUSES)[number][],
          ),
        );
      }
      if (game) conds.push(eq(deposits.selected_game, game));
      const rows = await db
        .select()
        .from(deposits)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(deposits.created_at))
        .limit(limit);
      const gameInfo = await playerGameInfoMap(rows.map((r) => r.player_id));
      items.push(
        ...rows.map((r) =>
          depositToBotJson(r, r.player_id ? gameInfo.get(r.player_id) : null),
        ),
      );
    }
  }

  if (wantWithdrawals) {
    const valid = statusList
      ? statusList.filter((s) =>
          (WITHDRAWAL_STATUSES as readonly string[]).includes(s),
        )
      : null;
    if (!(statusList && valid && valid.length === 0)) {
      const conds: SQL[] = [];
      if (valid) {
        conds.push(
          inArray(
            withdrawals.status,
            valid as (typeof WITHDRAWAL_STATUSES)[number][],
          ),
        );
      }
      if (game) conds.push(eq(withdrawals.game_name, game));
      const rows = await db
        .select()
        .from(withdrawals)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(withdrawals.created_at))
        .limit(limit);
      items.push(...rows.map(withdrawalJson));
    }
  }

  // Merge newest-first when returning both types, then cap to the limit.
  if (type === "all") {
    items.sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    );
  }
  const out = items.slice(0, limit);

  return Response.json({ count: out.length, transactions: out });
}

const depositSchema = z.object({
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

const withdrawalSchema = z.object({
  type: z.literal("withdrawal"),
  player_id: z.number().int().positive(),
  requested_amount: z.number().positive(),
  game_name: z.string().min(1),
  bank_name: z.string().optional(),
  bank_account_number: z.string().optional(),
});

/**
 * POST /api/bot/transactions
 * Create a transaction. Routed by top-level `type`:
 *   - `type: "withdrawal"` → logs a withdrawal request (starts "requested").
 *   - otherwise → a deposit from a detected bank credit. Idempotent on
 *     external_id (re-sending the same queue item returns the existing row).
 * Legacy deposit callers send bank direction as `type: "credit"` (or nested
 * `transaction.type`); those stay on the deposit path.
 */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const topType =
    body && typeof body === "object"
      ? (body as { type?: unknown }).type
      : undefined;

  // ---- Withdrawal branch ----
  if (topType === "withdrawal") {
    const parsed = withdrawalSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
        { status: 400 },
      );
    }
    const res = await createBotWithdrawal(parsed.data, {
      apiKeyLabel: auth.label,
    });
    if (!res.ok) {
      return Response.json({ error: res.error }, { status: res.status });
    }
    return Response.json(
      { transaction: withdrawalJson(res.withdrawal) },
      { status: 201 },
    );
  }

  // ---- Deposit branch (bank credit) ----
  const parsed = depositSchema.safeParse(body);
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
      source: "bot",
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

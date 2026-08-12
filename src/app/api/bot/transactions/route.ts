import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  bankTransfers,
  deposits,
  entities,
  gameTransfers,
  transactions,
  withdrawals,
} from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import {
  bankTransferJson,
  gameTransferJson,
  withdrawalJson,
} from "@/lib/bot-crud";
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

const TRANSFER_STATUSES = [
  "pending_confirmation",
  "confirmed",
  "auto_confirmed",
  "rejected",
  "failed",
] as const;

const GAME_TRANSFER_STATUSES = [
  "pending",
  "solving",
  "processing",
  "completed",
  "failed",
] as const;

// `transfer` = bank transfer between entity accounts; `game_transfer` = a
// player's credits moved between two games. They are different tables and
// different workflows — accept a couple of spellings so the two aren't confused.
const TYPE_ALIASES: Record<string, string> = {
  "game-transfer": "game_transfer",
  game_transfers: "game_transfer",
  "game-transfers": "game_transfer",
  gametransfer: "game_transfer",
  transfers: "transfer",
  deposits: "deposit",
  withdrawals: "withdrawal",
};

/**
 * GET /api/bot/transactions?type=deposit|withdrawal|transfer|game_transfer|all&status=...&limit=50
 *
 * Deposits, withdrawals, bank transfers and game transfers live in separate
 * tables but are exposed here as one stream. Every item carries a `type`
 * ("deposit" | "withdrawal" | "transfer" | "game_transfer").
 *   - type=deposit (default): deposits; status defaults to pending_match.
 *   - type=withdrawal: withdrawal requests.
 *   - type=transfer: bank transfers between entity accounts.
 *   - type=game_transfer: CS-requested game credit moves.
 *     `status=pending,solving` is the agent's work queue — claim one with
 *     PATCH /api/bot/game-transfers/:id/status {status:"processing"}, do the
 *     provider-side move, then PATCH it to completed/failed.
 *   - type=all: all four, merged and sorted newest-first.
 * `status` accepts a comma list; values are matched against whichever type(s)
 * they're valid for. The `game` filter never matches bank transfers (they have
 * no game), so those are omitted from a game-filtered `type=all` query; game
 * transfers match on either side (from_game or to_game).
 */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const rawType = (url.searchParams.get("type") ?? "deposit").toLowerCase();
  const type = TYPE_ALIASES[rawType] ?? rawType;
  const statusParam = url.searchParams.get("status");
  // Filter to a single game (deposit.selected_game / withdrawal.game_name),
  // e.g. ?game=Mega888. Accepts `game` or `selected_game`.
  const game =
    url.searchParams.get("game") ?? url.searchParams.get("selected_game");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

  if (
    !["deposit", "withdrawal", "transfer", "game_transfer", "all"].includes(type)
  ) {
    return Response.json(
      {
        error:
          "Invalid type. Use: deposit, withdrawal, transfer, game_transfer, all",
      },
      { status: 400 },
    );
  }

  const wantDeposits = type === "deposit" || type === "all";
  const wantWithdrawals = type === "withdrawal" || type === "all";
  // Bank transfers have no game, so a game-filtered `all` query skips them.
  const wantTransfers = type === "transfer" || (type === "all" && !game);
  const wantGameTransfers = type === "game_transfer" || type === "all";
  const statusList = statusParam
    ? statusParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const items: Array<
    | ReturnType<typeof depositToBotJson>
    | ReturnType<typeof withdrawalJson>
    | ReturnType<typeof bankTransferJson>
    | ReturnType<typeof gameTransferJson>
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
      // Manual (skip-agent) deposits are never surfaced to the agent.
      const conds: SQL[] = [eq(deposits.skip_bot, false)];
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
      // Manual (skip-agent) withdrawals are never surfaced to the agent.
      const conds: SQL[] = [eq(withdrawals.skip_bot, false)];
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

  if (wantTransfers) {
    const valid = statusList
      ? statusList.filter((s) =>
          (TRANSFER_STATUSES as readonly string[]).includes(s),
        )
      : null;
    // Backward compat: a pure transfer query with a bad status is a 400.
    if (type === "transfer" && statusList && valid && valid.length === 0) {
      return Response.json(
        { error: `Invalid status. Use: ${TRANSFER_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }
    if (!(statusList && valid && valid.length === 0)) {
      // Manual (skip-agent) transfers are never surfaced to the agent.
      const conds: SQL[] = [eq(bankTransfers.skip_bot, false)];
      if (valid) {
        conds.push(
          inArray(
            bankTransfers.status,
            valid as (typeof TRANSFER_STATUSES)[number][],
          ),
        );
      }
      const rows = await db
        .select()
        .from(bankTransfers)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(bankTransfers.created_at))
        .limit(limit);
      items.push(...rows.map(bankTransferJson));
    }
  }

  if (wantGameTransfers) {
    const valid = statusList
      ? statusList.filter((s) =>
          (GAME_TRANSFER_STATUSES as readonly string[]).includes(s),
        )
      : null;
    // A pure game_transfer query with a status that means nothing here is a
    // 400 rather than a silently empty list — the same contract as the other
    // pure-type queries.
    if (type === "game_transfer" && statusList && valid && valid.length === 0) {
      return Response.json(
        { error: `Invalid status. Use: ${GAME_TRANSFER_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }
    if (!(statusList && valid && valid.length === 0)) {
      const conds: SQL[] = [];
      if (valid) {
        conds.push(
          inArray(
            gameTransfers.status,
            valid as (typeof GAME_TRANSFER_STATUSES)[number][],
          ),
        );
      }
      // A game transfer touches two games; match either side.
      if (game) {
        conds.push(
          or(
            eq(gameTransfers.from_game, game),
            eq(gameTransfers.to_game, game),
          )!,
        );
      }
      const rows = await db
        .select()
        .from(gameTransfers)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(gameTransfers.created_at))
        .limit(limit);
      const gameInfo = await playerGameInfoMap(rows.map((r) => r.player_id));
      items.push(
        ...rows.map((r) => gameTransferJson(r, gameInfo.get(r.player_id))),
      );
    }
  }

  // Merge newest-first when returning multiple types, then cap to the limit.
  if (type === "all") {
    items.sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    );
  }
  const out = items.slice(0, limit);

  return Response.json({ count: out.length, transactions: out });
}

const depositSchema = z.object({
  // Accept both our field names and the agent's queue-item shape
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
  // Which company (entity) the deposit belongs to. Accepts either name.
  company_entity_id: z.number().int().positive().optional(),
  entity_id: z.number().int().positive().optional(),
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
    company_entity_id: raw.company_entity_id ?? raw.entity_id,
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

  if (input.company_entity_id !== undefined) {
    if (auth.companyId !== null && input.company_entity_id !== auth.companyId) {
      return Response.json(
        { error: `Entity ${input.company_entity_id} is outside this key's company scope` },
        { status: 403 },
      );
    }
    const [entity] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, input.company_entity_id));
    if (!entity || entity.entity_type !== "company") {
      return Response.json(
        { error: `Entity ${input.company_entity_id} is not a company` },
        { status: 422 },
      );
    }
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
      // Explicit agent-stated entity wins; then the matched player's company, the
      // receiving account's entity, and finally the key's company scope.
      company_entity_id:
        input.company_entity_id ??
        player?.company_entity_id ??
        account?.entity_id ??
        auth.companyId ??
        null,
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
    entity_id: created.company_entity_id,
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

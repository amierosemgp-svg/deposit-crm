import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, bankTransfers, transactions } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { getSettingNumber, transferAllowed } from "@/lib/api-helpers";
import { BotError, botErrorResponse, bankTransferJson, jsonError } from "@/lib/bot-crud";

const STATUSES = [
  "pending_confirmation",
  "confirmed",
  "auto_confirmed",
  "rejected",
  "failed",
] as const;

/** GET /api/bot/transfers?status=&account_id=&limit=&offset= */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const accountId = url.searchParams.get("account_id");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const filters: SQL[] = [];
  if (statusParam) {
    const wanted = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is (typeof STATUSES)[number] =>
        (STATUSES as readonly string[]).includes(s),
      );
    if (wanted.length) filters.push(inArray(bankTransfers.status, wanted));
  }

  const rows = await db
    .select()
    .from(bankTransfers)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(bankTransfers.transfer_id))
    .limit(limit)
    .offset(offset);

  const filtered = accountId
    ? rows.filter(
        (r) =>
          r.from_account_id === Number(accountId) ||
          r.to_account_id === Number(accountId),
      )
    : rows;

  return Response.json({
    count: filtered.length,
    transfers: filtered.map(bankTransferJson),
  });
}

const createSchema = z.object({
  from_account_id: z.number().int().positive(),
  to_account_id: z.number().int().positive(),
  amount: z.number().positive(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

/**
 * POST /api/bot/transfers — create a bank transfer.
 * Same rule as the internal API: company → company under the same leader, or
 * leader → own company. Sender is debited immediately; recipient is credited on
 * confirm (or automatically when the window expires).
 */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
  }
  const body = parsed.data;
  if (body.from_account_id === body.to_account_id) {
    return jsonError("Cannot transfer to the same account");
  }

  try {
    const result = await db.transaction(async (txn) => {
      const accounts = await txn
        .select()
        .from(bankAccounts)
        .where(
          inArray(bankAccounts.account_id, [
            body.from_account_id,
            body.to_account_id,
          ]),
        )
        .for("update");
      const from = accounts.find((a) => a.account_id === body.from_account_id);
      const to = accounts.find((a) => a.account_id === body.to_account_id);
      if (!from || !to) throw new BotError(404, "Account not found");
      if (from.status !== "active" || to.status !== "active") {
        throw new BotError(422, "Both accounts must be active");
      }

      const rule = await transferAllowed(from.entity_id, to.entity_id);
      if (!rule.allowed) {
        throw new BotError(422, rule.reason ?? "Transfer not allowed");
      }
      if (from.current_balance < body.amount) {
        throw new BotError(
          422,
          `Insufficient balance (${from.current_balance.toFixed(2)} available)`,
        );
      }

      const hours = await getSettingNumber("transfer_auto_confirm_hours", 24);
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();

      await txn
        .update(bankAccounts)
        .set({ current_balance: +(from.current_balance - body.amount).toFixed(2) })
        .where(eq(bankAccounts.account_id, from.account_id));

      const [transfer] = await txn
        .insert(bankTransfers)
        .values({
          from_account_id: from.account_id,
          to_account_id: to.account_id,
          amount: body.amount,
          reference: body.reference?.trim() || `TRF-${nowIso}`,
          notes: body.notes?.trim() || null,
          status: "pending_confirmation",
          expires_at: expiresAt,
          created_at: nowIso,
        })
        .returning();

      await txn.insert(transactions).values({
        entity_id: from.entity_id,
        type: "bank_transfer",
        amount: body.amount,
        reference_id: transfer.transfer_id,
        details: {
          action: "initiated",
          from_account: from.account_number,
          to_account: to.account_number,
          expires_at: expiresAt,
          source: "bot",
        },
      });

      return transfer;
    });

    return Response.json({ transfer: bankTransferJson(result) }, { status: 201 });
  } catch (e) {
    return botErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

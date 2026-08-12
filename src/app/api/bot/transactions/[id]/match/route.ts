import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, transactions } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { depositToBotJson, parseBotDate } from "@/lib/bot-transactions";

const matchSchema = z.object({
  bank: z.string().optional(),
  date: z.string().optional(),
  description: z.string().optional(),
  amount: z.number().optional(),
  raw_amount: z.string().optional(),
  extracted_at: z.string().optional(),
  external_id: z.string().optional(),
  receipt_url: z.string().url().optional(),
});

/**
 * PATCH /api/bot/transactions/:id/match
 * Agent use-case #2: confirm a pending CRM transaction against a detected
 * bank credit. Moves status pending_match → matched and stores the bank
 * details the agent extracted.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const numeric = Number(id);
  const [row] = Number.isInteger(numeric) && numeric > 0
    ? await db.select().from(deposits).where(eq(deposits.deposit_id, numeric))
    : await db.select().from(deposits).where(eq(deposits.external_id, id));

  if (!row) {
    return Response.json({ error: "Transaction not found" }, { status: 404 });
  }
  if (row.status !== "pending_match") {
    return Response.json(
      {
        error: `Transaction is "${row.status}", only pending_match can be matched`,
        transaction: depositToBotJson(row),
      },
      { status: 409 },
    );
  }

  const parsed = matchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (body.amount !== undefined && Math.abs(body.amount - row.deposit_amount) > 0.005) {
    return Response.json(
      {
        error: `Amount mismatch: expected ${row.deposit_amount}, bank shows ${body.amount}`,
      },
      { status: 422 },
    );
  }

  const nowIso = new Date().toISOString();
  const [updated] = await db
    .update(deposits)
    .set({
      status: "matched",
      matched_at: nowIso,
      bank_name: body.bank ?? row.bank_name,
      bank_description: body.description ?? row.bank_description,
      external_id: body.external_id ?? row.external_id,
      receipt_url: body.receipt_url ?? row.receipt_url,
      deposit_date: body.date
        ? parseBotDate(body.date, body.extracted_at)
        : row.deposit_date,
      updated_at: nowIso,
    })
    .where(eq(deposits.deposit_id, row.deposit_id))
    .returning();

  await db.insert(transactions).values({
    player_id: row.player_id,
    entity_id: updated.company_entity_id,
    type: "deposit",
    amount: row.deposit_amount,
    reference_id: row.deposit_id,
    details: {
      source: "bot",
      action: "match_confirmed",
      api_key_label: auth.label,
      bank_description: body.description,
      external_id: body.external_id,
    },
  });

  return Response.json({ transaction: depositToBotJson(updated) });
}

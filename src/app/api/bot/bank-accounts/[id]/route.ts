import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { bankAccountJson, isFkViolation, jsonError } from "@/lib/bot-crud";

/** GET /api/bot/bank-accounts/:id */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const [row] = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.account_id, Number(id)));
  if (!row) return jsonError("Bank account not found", 404);
  return Response.json({ bank_account: bankAccountJson(row) });
}

const patchSchema = z.object({
  role: z.enum(["deposit", "withdrawal"]).optional(),
  bank_name: z.string().min(1).optional(),
  account_number: z.string().min(4).optional(),
  account_holder: z.string().min(1).optional(),
  label: z.string().nullable().optional(),
  current_balance: z.number().min(0).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

/** PATCH /api/bot/bank-accounts/:id */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid payload");

  const [updated] = await db
    .update(bankAccounts)
    .set(parsed.data)
    .where(eq(bankAccounts.account_id, Number(id)))
    .returning();
  if (!updated) return jsonError("Bank account not found", 404);
  return Response.json({ bank_account: bankAccountJson(updated) });
}

/** DELETE /api/bot/bank-accounts/:id — blocked if it still holds a balance or is referenced. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const accountId = Number(id);

  const [row] = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.account_id, accountId));
  if (!row) return jsonError("Bank account not found", 404);
  if (row.current_balance > 0) {
    return jsonError("Transfer the balance out before deleting this account", 422);
  }

  try {
    await db.delete(bankAccounts).where(eq(bankAccounts.account_id, accountId));
    return Response.json({ ok: true, deleted: accountId });
  } catch (e) {
    if (isFkViolation(e)) {
      return jsonError("Account is referenced by transfers or transactions", 409);
    }
    console.error(e);
    return jsonError("Server error", 500);
  }
}

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { withdrawals } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { isFkViolation, jsonError, withdrawalJson } from "@/lib/bot-crud";

/** GET /api/bot/withdrawals/:id */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const [row] = await db
    .select()
    .from(withdrawals)
    .where(eq(withdrawals.withdrawal_id, Number(id)));
  if (!row) return jsonError("Withdrawal not found", 404);
  return Response.json({ withdrawal: withdrawalJson(row) });
}

const patchSchema = z.object({
  requested_amount: z.number().positive().optional(),
  game_name: z.string().min(1).optional(),
  bank_name: z.string().nullable().optional(),
  bank_account_number: z.string().nullable().optional(),
});

/**
 * PATCH /api/bot/withdrawals/:id — edit request details.
 * Only allowed while the withdrawal is still "requested" (before money moves).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid payload");

  const [row] = await db
    .select()
    .from(withdrawals)
    .where(eq(withdrawals.withdrawal_id, Number(id)));
  if (!row) return jsonError("Withdrawal not found", 404);
  if (row.status !== "requested") {
    return jsonError(
      `Withdrawal is "${row.status}"; only "requested" withdrawals can be edited`,
      409,
    );
  }

  const [updated] = await db
    .update(withdrawals)
    .set({ ...parsed.data, updated_at: new Date().toISOString() })
    .where(eq(withdrawals.withdrawal_id, Number(id)))
    .returning();
  return Response.json({ withdrawal: withdrawalJson(updated) });
}

/**
 * DELETE /api/bot/withdrawals/:id — cancel a withdrawal.
 * Blocked once credits have been pulled or it was paid (409) to protect money movement.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const withdrawalId = Number(id);

  const [row] = await db
    .select()
    .from(withdrawals)
    .where(eq(withdrawals.withdrawal_id, withdrawalId));
  if (!row) return jsonError("Withdrawal not found", 404);
  if (row.status !== "requested") {
    return jsonError(
      `Withdrawal is "${row.status}"; credits already moved — cannot delete`,
      409,
    );
  }

  try {
    await db.delete(withdrawals).where(eq(withdrawals.withdrawal_id, withdrawalId));
    return Response.json({ ok: true, deleted: withdrawalId });
  } catch (e) {
    if (isFkViolation(e)) return jsonError("Withdrawal is still referenced", 409);
    console.error(e);
    return jsonError("Server error", 500);
  }
}

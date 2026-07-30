import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, gameTransfers, withdrawals } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * Claiming a transaction ("Assign to me") so two CS agents don't work the same
 * one. Purely an ownership marker — it doesn't change the transaction's status
 * or block anyone from acting, it just makes who's on it visible in the list.
 */
const KINDS = {
  deposit: {
    table: deposits,
    id: deposits.deposit_id,
    assignee: deposits.assigned_to_user_id,
  },
  withdrawal: {
    table: withdrawals,
    id: withdrawals.withdrawal_id,
    assignee: withdrawals.assigned_to_user_id,
  },
  game_transfer: {
    table: gameTransfers,
    id: gameTransfers.transfer_id,
    assignee: gameTransfers.assigned_to_user_id,
  },
} as const;

const bodySchema = z.object({
  kind: z.enum(["deposit", "withdrawal", "game_transfer"]),
  id: z.number().int().positive(),
  // Omitted or true claims it for the caller; false releases it.
  assign: z.boolean().optional(),
});

/** POST /api/assignments — claim or release a transaction. */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Provide kind (deposit | withdrawal | game_transfer) and id");
    }
    const { kind, id, assign = true } = parsed.data;
    const target = KINDS[kind];

    const nowIso = new Date().toISOString();
    const [row] = await db
      .select()
      .from(target.table)
      .where(eq(target.id, id));
    if (!row) throw new AuthError(404, "Transaction not found");

    // Releasing someone else's claim would let agents silently steal work.
    if (
      !assign &&
      row.assigned_to_user_id !== null &&
      row.assigned_to_user_id !== user.user_id
    ) {
      throw new AuthError(403, "This is assigned to someone else");
    }

    const [updated] = await db
      .update(target.table)
      .set(
        assign
          ? { assigned_to_user_id: user.user_id, assigned_at: nowIso }
          : { assigned_to_user_id: null, assigned_at: null },
      )
      .where(eq(target.id, id))
      .returning();

    return Response.json({ ok: true, assignment: updated });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

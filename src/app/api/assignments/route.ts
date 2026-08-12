import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, gameTransfers, withdrawals } from "@/db/schema";
import { authErrorResponse, requireWriteUser } from "@/lib/auth";
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
    // Approving hands the deposit to the agent under your name, so the claim
    // stops being advisory at that point — it is the record of who dispatched
    // it. Only a deposit still awaiting action can be handed back.
    releasable: inArray(deposits.status, ["pending", "matched"]),
    lockedMessage:
      "Already approved — an approved deposit stays with whoever dispatched it",
  },
  withdrawal: {
    table: withdrawals,
    id: withdrawals.withdrawal_id,
    assignee: withdrawals.assigned_to_user_id,
    releasable: undefined,
    lockedMessage: undefined,
  },
  game_transfer: {
    table: gameTransfers,
    id: gameTransfers.transfer_id,
    assignee: gameTransfers.assigned_to_user_id,
    releasable: undefined,
    lockedMessage: undefined,
  },
} as const;

const bodySchema = z
  .object({
    kind: z.enum(["deposit", "withdrawal", "game_transfer"]),
    id: z.number().int().positive().optional(),
    ids: z.array(z.number().int().positive()).min(1).max(200).optional(),
    // Omitted or true claims it for the caller; false releases it.
    assign: z.boolean().optional(),
  })
  .refine((b) => b.id !== undefined || b.ids !== undefined, {
    message: "Provide id or ids",
  });

/**
 * POST /api/assignments — claim or release one transaction (`id`) or a batch
 * (`ids`, up to 200).
 *
 * Both directions refuse to touch someone else's claim. Silently reassigning
 * twenty transactions out from under a colleague mid-queue is exactly the
 * confusion this feature exists to prevent, so those are skipped and counted
 * rather than taken.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(
        "Provide kind (deposit | withdrawal | game_transfer) and id or ids",
      );
    }
    const { kind, assign = true } = parsed.data;
    const ids = parsed.data.ids ?? [parsed.data.id!];
    const target = KINDS[kind];

    const nowIso = new Date().toISOString();

    // Only rows that are unclaimed or already ours. Anything held by someone
    // else falls out here and is reported as skipped.
    const claimable = or(
      isNull(target.assignee),
      eq(target.assignee, user.user_id),
    )!;

    // Releasing can be blocked per kind once the row has moved on (see KINDS).
    const releaseGuard = assign ? undefined : target.releasable;

    const updated = await db
      .update(target.table)
      .set(
        assign
          ? { assigned_to_user_id: user.user_id, assigned_at: nowIso }
          : { assigned_to_user_id: null, assigned_at: null },
      )
      .where(and(inArray(target.id, ids), claimable, releaseGuard))
      .returning({ id: target.id });

    const changed = updated.length;
    const skipped = ids.length - changed;

    if (changed === 0) {
      if (releaseGuard && target.lockedMessage) {
        // Nothing moved on a release — either someone else holds it, or it is
        // past the point where it can be handed back. Say which.
        const [stillClaimable] = await db
          .select({ id: target.id })
          .from(target.table)
          .where(and(inArray(target.id, ids), claimable));
        if (stillClaimable) return jsonError(target.lockedMessage, 409);
      }
      return jsonError(
        ids.length === 1
          ? "That transaction is assigned to someone else"
          : "All selected transactions are assigned to someone else",
        409,
      );
    }

    return Response.json({ ok: true, changed, skipped });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

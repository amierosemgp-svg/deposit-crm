import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players, transactions, withdrawals } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { appendEditNote, describeChanges, diffFields, logActivity } from "@/lib/activity-log";
import { canonicalise } from "@/lib/game-name";

const patchSchema = z.object({
  requested_amount: z.number().positive().optional(),
  game_name: z.string().min(1).max(60).optional(),
  game_username: z.string().max(120).nullable().optional(),
  bank_name: z.string().max(60).nullable().optional(),
  bank_account_number: z.string().max(60).nullable().optional(),
});

/**
 * PATCH /api/withdrawals/:id — correct a request before anything is pulled.
 *
 * Only while the withdrawal is still "requested". Once credits have been
 * pulled the money has left the player's wallet, and changing the figure it
 * was pulled against would leave the request disagreeing with what actually
 * moved — the fix for that is to reject and re-enter, not to edit.
 *
 * Recorded twice, as deposits are: a `transactions` row for the History page,
 * and one activity_log entry with the before/after diff.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const withdrawalId = Number((await params).id);
    if (!Number.isInteger(withdrawalId)) return jsonError("Bad withdrawal id");

    const [row] = await db
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.withdrawal_id, withdrawalId));
    if (!row) return jsonError("Withdrawal not found", 404);

    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.player_id, row.player_id));
    if (
      user.companyIds !== null &&
      player &&
      !user.companyIds.includes(player.company_entity_id)
    ) {
      throw new AuthError(403, "Withdrawal is outside your company scope");
    }
    if (row.status !== "requested") {
      return jsonError(
        `Withdrawal is already ${row.status} — reject and re-enter it instead`,
        409,
      );
    }

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const body = parsed.data;

    // Through the catalogue, so an edit cannot introduce a spelling the rest
    // of the system does not recognise.
    const gameName =
      body.game_name !== undefined ? await canonicalise(body.game_name) : undefined;

    const [updated] = await db
      .update(withdrawals)
      .set({
        ...(body.requested_amount !== undefined
          ? { requested_amount: body.requested_amount }
          : {}),
        ...(gameName !== undefined ? { game_name: gameName } : {}),
        ...(body.game_username !== undefined
          ? { game_username: body.game_username }
          : {}),
        ...(body.bank_name !== undefined ? { bank_name: body.bank_name } : {}),
        ...(body.bank_account_number !== undefined
          ? { bank_account_number: body.bank_account_number }
          : {}),
        updated_at: new Date().toISOString(),
      })
      .where(eq(withdrawals.withdrawal_id, withdrawalId))
      .returning();

    const changes = diffFields(
      {
        requested_amount: row.requested_amount,
        game_name: row.game_name,
        game_username: row.game_username,
        bank_name: row.bank_name,
        bank_account_number: row.bank_account_number,
      },
      {
        requested_amount: updated.requested_amount,
        game_name: updated.game_name,
        game_username: updated.game_username,
        bank_name: updated.bank_name,
        bank_account_number: updated.bank_account_number,
      },
    );

    if (changes.length) {
      // amount = 0: nothing moved, this is a correction to a pending request.
      await db.insert(transactions).values({
        player_id: row.player_id,
        entity_id: player?.company_entity_id ?? null,
        type: "withdrawal",
        amount: 0,
        game_name: updated.game_name,
        reference_id: withdrawalId,
        user_id: user.user_id,
        details: {
          action: "edited",
          changes: changes.map((c) => ({ field: c.field, from: c.from, to: c.to })),
        },
      });
      await logActivity({
        category: "transaction",
        action: "withdrawal.edited",
        summary: `Withdrawal WD-${withdrawalId} edited — ${describeChanges(changes)}`,
        actor: user,
        companyEntityId: player?.company_entity_id ?? null,
        targetType: "withdrawal",
        targetId: withdrawalId,
        targetLabel: `WD-${withdrawalId}`,
        changes,
      });
      // …and on the row, which is where the sheet asks the question.
      const [withNote] = await db
        .update(withdrawals)
        .set({ edit_note: appendEditNote(row.edit_note, user, changes) })
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .returning();
      return Response.json({ withdrawal: withNote ?? updated });
    }

    return Response.json({ withdrawal: updated });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players, transactions, withdrawals } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { appendEditNote, describeChanges, diffFields, logActivity } from "@/lib/activity-log";
import { canonicalise } from "@/lib/game-name";
import { rebookPulledWithdrawal, reverseManualWithdrawal } from "@/lib/withdrawal-pull";

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
    /**
     * Correctable while it is still a request, and — for a row a person
     * handled — after the pull too, because a manual row is created already
     * pulled and "fix what I just typed" would otherwise be impossible. The
     * pull is re-booked below so the float and the row keep saying the same
     * thing. Once it is paid, money has left a bank account and the fix is a
     * reversal, not an edit.
     */
    const pulled = row.status === "credits_pulled";
    const rebooking = pulled && !!row.skip_bot;
    if (!(row.status === "requested" || rebooking)) {
      return jsonError(
        row.status === "credits_pulled"
          ? "The agent pulled that one — only manual rows can be corrected here"
          : `Withdrawal is already ${row.status} — reject and re-enter it instead`,
        409,
      );
    }


    /**
     * A row is corrected by whoever holds it.
     *
     * The sheet only offers the cells to the holder, but that is the UI's
     * courtesy, not a rule — two desks editing the same row is how a figure
     * gets corrected twice in opposite directions. An unheld row stays open:
     * the bot and the admin flows patch those, and nobody is racing for it.
     */
    if (
      row.assigned_to_user_id !== null &&
      row.assigned_to_user_id !== user.user_id
    ) {
      return jsonError(
        "That row is assigned to someone else — they have to release it first",
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

    const patch = {
      ...(body.requested_amount !== undefined
        ? {
            requested_amount: body.requested_amount,
            // On a pulled row the two figures are the same claim: CS pulled
            // what they typed. Leaving the pulled amount behind would pay the
            // player one number and account for another.
            ...(rebooking ? { credit_pulled_amount: body.requested_amount } : {}),
          }
        : {}),
      ...(gameName !== undefined ? { game_name: gameName } : {}),
      ...(body.game_username !== undefined ? { game_username: body.game_username } : {}),
      ...(body.bank_name !== undefined ? { bank_name: body.bank_name } : {}),
      ...(body.bank_account_number !== undefined
        ? { bank_account_number: body.bank_account_number }
        : {}),
      updated_at: new Date().toISOString(),
    };

    const updated = await db.transaction(async (txn) => {
      const [saved] = await txn
        .update(withdrawals)
        .set(patch)
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .returning();
      const moved =
        saved.credit_pulled_amount !== row.credit_pulled_amount ||
        saved.game_name !== row.game_name ||
        saved.game_username !== row.game_username;
      if (rebooking && moved && player) {
        await rebookPulledWithdrawal(txn, { before: row, after: saved, player, userId: user.user_id });
      }
      return saved;
    });

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

/**
 * DELETE /api/withdrawals/:id — remove a row keyed wrong, giving back whatever
 * it moved: the bank repaid, the float's credit taken back off it, the
 * member's wallet and total_withdrawals restored.
 *
 * Gated like the deposit delete — own company, not held by someone else, and
 * manual rows only, because a row the agent pulled is the agent's record of
 * credit that really left the kiosk.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const withdrawalId = Number((await params).id);

    const row = await db.transaction(async (txn) => {
      const [wd] = await txn
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .for("update");
      if (!wd) throw new AuthError(404, "Withdrawal not found");

      const [player] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, wd.player_id));
      if (!player) throw new AuthError(404, "Player not found");
      if (user.companyIds !== null && !user.companyIds.includes(player.company_entity_id)) {
        throw new AuthError(403, "Withdrawal is outside your company scope");
      }
      // Held by the person deleting it — see the deposit delete for why a
      // delete demands the claim where an edit does not.
      if (wd.assigned_to_user_id !== user.user_id) {
        throw new AuthError(
          409,
          wd.assigned_to_user_id === null
            ? "Assign the row to yourself before deleting it"
            : "That row is assigned to someone else — they have to release it first",
        );
      }
      if (!wd.skip_bot) {
        throw new AuthError(
          409,
          "That withdrawal was handled by the agent — only manual rows can be deleted here",
        );
      }

      await reverseManualWithdrawal(txn, { row: wd, player, userId: user.user_id });

      await txn.insert(transactions).values({
        player_id: wd.player_id,
        entity_id: player.company_entity_id,
        type: "withdrawal",
        amount: -wd.credit_pulled_amount,
        game_name: wd.game_name,
        user_id: user.user_id,
        details: {
          source: "manual",
          action: "withdrawal_deleted",
          withdrawal_id: wd.withdrawal_id,
          player_username: player.username,
          requested: wd.requested_amount,
          pulled: wd.credit_pulled_amount,
          paid_from_account_id: wd.paid_from_account_id,
          status_before: wd.status,
          // Which row, when two on one shift are otherwise identical.
          requested_at: wd.created_at,
        },
      });

      await txn.delete(withdrawals).where(eq(withdrawals.withdrawal_id, withdrawalId));
      return { wd, player };
    });

    await logActivity({
      category: "transaction",
      action: "withdrawal.deleted",
      summary:
        `Withdrawal deleted: ${row.player.username} — ` +
        `RM ${row.wd.credit_pulled_amount.toFixed(2)} ${row.wd.game_name} ` +
        `requested ${row.wd.created_at} (was ${row.wd.status})`,
      actor: user,
      companyEntityId: row.player.company_entity_id,
      targetType: "withdrawal",
      targetId: row.wd.withdrawal_id,
      targetLabel: row.player.username,
      context: {
        requested: row.wd.requested_amount,
        pulled: row.wd.credit_pulled_amount,
        game: row.wd.game_name,
        paid_from_account_id: row.wd.paid_from_account_id,
        requested_at: row.wd.created_at,
        status_before: row.wd.status,
      },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

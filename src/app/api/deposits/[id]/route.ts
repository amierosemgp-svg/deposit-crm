import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { canOverrideEligibility, resolveBonusForDeposit } from "@/lib/bonus";
import { rebookCompletedDeposit } from "@/lib/deposit-complete";
import { InsufficientKioskCreditError } from "@/lib/kiosk-credit";
import {
  appendEditNote,
  describeChanges,
  diffFields,
  logActivity,
} from "@/lib/activity-log";

const patchSchema = z.object({
  // The bonus to apply; null clears it back to no bonus.
  bonus_plan_id: z.number().int().positive().nullable().optional(),
  // The old free-percentage path, still honoured when no plan is named.
  bonus_percentage: z.number().min(0).max(200).optional(),
  // Leaders/admins only: force a bonus the player isn't entitled to, on record.
  bonus_override_reason: z.string().max(200).optional(),
  selected_game: z.string().nullable().optional(),
  player_id: z.number().int().positive().optional(), // assign an unmatched bot deposit
  // The rest of a worksheet row. Editable for the same reason the bonus is:
  // no money has moved yet. total_deposits, the player's game credit and the
  // company BO pool are all booked at completion, and a completed deposit is
  // refused below — so correcting a mistyped figure here costs nothing to undo.
  deposit_amount: z.number().positive().optional(),
  bank_name: z.string().min(1).max(60).optional(),
  selected_game_username: z.string().max(120).nullable().optional(),
  deposit_date: z.string().datetime({ offset: true }).optional(),
});

/**
 * PATCH /api/deposits/:id — correct a row that has not settled yet.
 *
 * Amount, bank, player, game, kiosk login, date and bonus are all fixable
 * while the deposit is in flight; a completed or failed one is refused,
 * because by then the money is booked and an edit would silently disagree with
 * the ledger.
 *
 * Every change is recorded twice on purpose: a `transactions` row per field,
 * which is what the History page reads, and one activity_log entry carrying
 * the whole before/after diff, which is what answers "who changed this, and
 * what did it say before".
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const depositId = Number(id);

    const [row] = await db
      .select()
      .from(deposits)
      .where(eq(deposits.deposit_id, depositId));
    if (!row) return jsonError("Deposit not found", 404);
    if (
      user.companyIds !== null &&
      row.company_entity_id !== null &&
      !user.companyIds.includes(row.company_entity_id)
    ) {
      throw new AuthError(403, "Deposit is outside your company scope");
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
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    /**
     * A completed deposit is correctable, so long as a person did it.
     *
     * Manual rows complete the moment they are saved, so "fix the row you just
     * typed" is the normal case, not an exception — and the money it moved is
     * unwound and re-laid below rather than left to disagree with the row.
     *
     * A row the agent completed is not editable: its booking is the agent's
     * own record of what it did at the provider, and rewriting it here would
     * leave the CRM claiming something the kiosk never saw. Same for a failed
     * row, which never booked anything to correct.
     */
    const settled = row.status === "completed";
    const rebooking = settled && !!row.skip_bot;
    if (settled && !row.skip_bot) {
      return jsonError(
        "That deposit was completed by the agent — only manual rows can be corrected here",
        409,
      );
    }
    if (row.status === "failed") {
      return jsonError("Deposit is already failed", 409);
    }

    let playerPatch = {};
    let playerId = row.player_id;
    let companyEntityId = row.company_entity_id;
    if (body.player_id !== undefined) {
      const [player] = await db
        .select()
        .from(players)
        .where(eq(players.player_id, body.player_id));
      if (!player) return jsonError("Player not found", 404);
      if (
        user.companyIds !== null &&
        !user.companyIds.includes(player.company_entity_id)
      ) {
        throw new AuthError(403, "Player is outside your company scope");
      }
      playerPatch = {
        player_id: player.player_id,
        player_username: player.username,
        company_entity_id: player.company_entity_id,
      };
      playerId = player.player_id;
      companyEntityId = player.company_entity_id;
    }

    // A bare percentage means "no plan" — it's the ad-hoc path, so naming one
    // clears whatever plan the row was carrying.
    const touchesBonus =
      body.bonus_plan_id !== undefined || body.bonus_percentage !== undefined;
    // Re-assigning the player invalidates a plan that was checked against the
    // previous one: the new player may already have had the welcome bonus.
    const playerChanged =
      body.player_id !== undefined && body.player_id !== row.player_id;
    const recheckBonus = touchesBonus || (playerChanged && !!row.bonus_plan_id);

    let bonusPatch: Record<string, unknown> = {};
    let bonusNote: Record<string, unknown> | null = null;

    if (recheckBonus) {
      const wantedPlanId = touchesBonus
        ? (body.bonus_plan_id ?? null)
        : row.bonus_plan_id;

      if (wantedPlanId !== null && playerId === null) {
        return jsonError("Assign a player before picking a bonus", 422);
      }

      const resolved =
        playerId === null
          ? null
          : await resolveBonusForDeposit({
              planId: wantedPlanId,
              // Clearing the bonus means clearing it: only carry the row's old
              // percentage forward when this request isn't the one removing it.
              fallbackPercentage:
                body.bonus_percentage ??
                (body.bonus_plan_id === null ? 0 : row.bonus_percentage),
              ctx: {
                playerId,
                companyEntityId,
                depositAmount: row.deposit_amount,
                // The row being edited is not its own competition.
                excludeDepositId: depositId,
              },
              override: {
                allowed:
                  canOverrideEligibility(user.role) &&
                  !!body.bonus_override_reason,
                reason: body.bonus_override_reason,
              },
            });

      if (resolved && !resolved.ok) {
        // A bonus CS deliberately picked is worth an error. A bonus that only
        // stopped applying because the deposit changed hands is not: assigning
        // the player is the point of the request, so the stale bonus is dropped
        // and recorded rather than blocking the assignment.
        if (touchesBonus) return jsonError(resolved.reason, resolved.status);
        bonusPatch = {
          bonus_plan_id: null,
          bonus_percentage: 0,
          bonus_amount: 0,
          bonus_basis_amount: null,
          bonus_override_reason: null,
          total_amount: row.deposit_amount,
        };
        bonusNote = { action: "bonus_cleared", reason: resolved.reason };
      } else if (resolved?.ok) {
        bonusPatch = resolved.fields;
        bonusNote = {
          action: "bonus_changed",
          from: row.bonus_percentage,
          to: resolved.fields.bonus_percentage,
          bonus: resolved.plan?.name ?? null,
          bonus_plan_id: resolved.fields.bonus_plan_id,
          bonus_amount: resolved.fields.bonus_amount,
          ...(resolved.fields.bonus_override_reason
            ? { bonus_override_reason: resolved.fields.bonus_override_reason }
            : {}),
        };
      }
    }

    /**
     * A new amount re-bases the bonus.
     *
     * The percentage is what CS chose; the cash figure follows from it. Left
     * alone, correcting 500 to 50 would keep a bonus struck on the larger
     * number and the deposit would credit more than it took in.
     */
    let amountPatch = {};
    if (body.deposit_amount !== undefined && body.deposit_amount !== row.deposit_amount) {
      const pct =
        (bonusPatch as { bonus_percentage?: number }).bonus_percentage ??
        row.bonus_percentage;
      const bonus = +((body.deposit_amount * pct) / 100).toFixed(2);
      amountPatch = {
        deposit_amount: body.deposit_amount,
        bonus_amount: bonus,
        total_amount: +(body.deposit_amount + bonus).toFixed(2),
      };
    }

    const nowIso = new Date().toISOString();
    const patch = {
      ...playerPatch,
      ...bonusPatch,
      ...amountPatch,
      ...(body.bank_name !== undefined ? { bank_name: body.bank_name } : {}),
      ...(body.selected_game_username !== undefined
        ? { selected_game_username: body.selected_game_username }
        : {}),
      ...(body.deposit_date !== undefined
        ? { deposit_date: body.deposit_date, deposit_time_known: true }
        : {}),
      selected_game:
        body.selected_game !== undefined ? body.selected_game : row.selected_game,
      updated_at: nowIso,
    };

    /**
     * The correction and its re-booking commit together. Half of this — a row
     * that says RM 50 over credit of RM 550 — is worse than either outcome.
     */
    const { updated, negativeWallets } = await db.transaction(async (txn) => {
      const [saved] = await txn
        .update(deposits)
        .set(patch)
        .where(eq(deposits.deposit_id, depositId))
        .returning();

      if (!rebooking) return { updated: saved, negativeWallets: [] };
      const moved =
        saved.total_amount !== row.total_amount ||
        saved.deposit_amount !== row.deposit_amount ||
        saved.selected_game !== row.selected_game ||
        saved.selected_game_username !== row.selected_game_username ||
        saved.player_id !== row.player_id;
      if (!moved) return { updated: saved, negativeWallets: [] };

      const { negativeWallets } = await rebookCompletedDeposit(txn, {
        before: row,
        after: saved,
        userId: user.user_id,
        nowIso,
      });
      return { updated: saved, negativeWallets };
    });

    // Audit each draft edit that actually changed a value. amount = 0 because
    // no money moves on a draft edit (that happens at approval).
    const audits: (typeof transactions.$inferInsert)[] = [];
    const base = {
      player_id: updated.player_id,
      entity_id: updated.company_entity_id,
      type: "deposit" as const,
      amount: 0,
      reference_id: depositId,
      user_id: user.user_id,
    };
    if (body.player_id !== undefined && body.player_id !== row.player_id) {
      audits.push({
        ...base,
        details: {
          action: "player_assigned",
          player: updated.player_username,
          transaction_ref: row.transaction_ref,
        },
      });
    }
    if (
      bonusNote &&
      (bonusPatch.bonus_plan_id !== row.bonus_plan_id ||
        bonusPatch.bonus_percentage !== row.bonus_percentage)
    ) {
      audits.push({
        ...base,
        details: { ...bonusNote, transaction_ref: row.transaction_ref },
      });
    }
    if (
      body.selected_game !== undefined &&
      body.selected_game !== row.selected_game
    ) {
      audits.push({
        ...base,
        details: {
          action: "game_selected",
          from: row.selected_game,
          to: body.selected_game,
          transaction_ref: row.transaction_ref,
        },
      });
    }
    if (audits.length) await db.insert(transactions).values(audits);

    // The whole diff, in the one place built for it. `transactions` says what
    // kind of change happened; this says what the value was before, which is
    // the question actually asked when a figure looks wrong.
    const changes = diffFields(
      {
        deposit_amount: row.deposit_amount,
        bank_name: row.bank_name,
        selected_game: row.selected_game,
        selected_game_username: row.selected_game_username,
        deposit_date: row.deposit_date,
        bonus_percentage: row.bonus_percentage,
        bonus_amount: row.bonus_amount,
        player_username: row.player_username,
      },
      {
        deposit_amount: updated.deposit_amount,
        bank_name: updated.bank_name,
        selected_game: updated.selected_game,
        selected_game_username: updated.selected_game_username,
        deposit_date: updated.deposit_date,
        bonus_percentage: updated.bonus_percentage,
        bonus_amount: updated.bonus_amount,
        player_username: updated.player_username,
      },
    );
    let edited = updated;
    if (changes.length) {
      await logActivity({
        category: "transaction",
        action: "deposit.edited",
        summary: `Deposit ${updated.transaction_ref} edited — ${describeChanges(changes)}`,
        actor: user,
        companyEntityId: updated.company_entity_id,
        targetType: "deposit",
        targetId: depositId,
        targetLabel: updated.transaction_ref,
        changes,
      });
      // The same sentence, on the row, because that is where it gets read.
      const [withNote] = await db
        .update(deposits)
        .set({ edit_note: appendEditNote(row.edit_note, user, changes) })
        .where(eq(deposits.deposit_id, depositId))
        .returning();
      edited = withNote ?? updated;
    }

    return Response.json({
      deposit: edited,
      ...(negativeWallets.length
        ? {
            warning:
              `Corrected, but the player has already spent some of it — ` +
              negativeWallets
                .map(
                  (w) =>
                    `${w.game}${w.login ? ` ${w.login}` : ""} is now ${w.balance.toFixed(2)}`,
                )
                .join(", ") +
              `. Sync the kiosk balance.`,
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof InsufficientKioskCreditError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { canOverrideEligibility, resolveBonusForDeposit } from "@/lib/bonus";

const patchSchema = z.object({
  // The bonus to apply; null clears it back to no bonus.
  bonus_plan_id: z.number().int().positive().nullable().optional(),
  // The old free-percentage path, still honoured when no plan is named.
  bonus_percentage: z.number().min(0).max(200).optional(),
  // Leaders/admins only: force a bonus the player isn't entitled to, on record.
  bonus_override_reason: z.string().max(200).optional(),
  selected_game: z.string().nullable().optional(),
  player_id: z.number().int().positive().optional(), // assign an unmatched bot deposit
});

/** PATCH /api/deposits/:id — edit the working draft (bonus %, game, player assignment). */
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
    if (["completed", "failed"].includes(row.status)) {
      return jsonError(`Deposit is already ${row.status}`, 409);
    }

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

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

    const [updated] = await db
      .update(deposits)
      .set({
        ...playerPatch,
        ...bonusPatch,
        selected_game:
          body.selected_game !== undefined ? body.selected_game : row.selected_game,
        updated_at: new Date().toISOString(),
      })
      .where(eq(deposits.deposit_id, depositId))
      .returning();

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

    return Response.json({ deposit: updated });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

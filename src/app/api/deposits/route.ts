import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { canOverrideEligibility, resolveBonusForDeposit } from "@/lib/bonus";

const createSchema = z.object({
  player_id: z.number().int().positive(),
  amount: z.number().positive(),
  bank_name: z.string().min(1),
  // "pending_match" = intent, waiting for the agent to confirm the bank credit.
  // "pending" = CS already sighted the receipt, straight to approval queue.
  status: z.enum(["pending_match", "pending"]).default("pending_match"),
  selected_game: z.string().optional(),
  // Which login under selected_game to top up. Omit for the player's first.
  selected_game_username: z.string().max(120).optional(),
  // The bonus to apply, checked against the player's history before it sticks.
  bonus_plan_id: z.number().int().positive().nullable().optional(),
  // The old free-percentage path, still honoured when no plan is named.
  bonus_percentage: z.number().min(0).max(200).optional(),
  // Leaders/admins only: force a bonus the player isn't entitled to, on record.
  bonus_override_reason: z.string().max(200).optional(),
  receipt_url: z.string().url().optional(),
  notes: z.string().optional(),
  // Fully manual: no agent bank-match or top-up — CS approves → completes it.
  skip_bot: z.boolean().optional(),
  // Claim it under the caller's name as it's created (the sheet's "Assign to
  // me" cell) — the same ownership marker POST /api/assignments sets.
  assign_to_me: z.boolean().optional(),
});

/**
 * POST /api/deposits — CS creates a deposit intent when the player says
 * "I've transferred RM50". The bot later confirms it via PATCH /api/bot/
 * transactions/:id/match (flow B).
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

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

    const bonus = await resolveBonusForDeposit({
      planId: body.bonus_plan_id ?? null,
      fallbackPercentage: body.bonus_percentage,
      ctx: {
        playerId: player.player_id,
        companyEntityId: player.company_entity_id,
        depositAmount: body.amount,
      },
      override: {
        allowed:
          canOverrideEligibility(user.role) && !!body.bonus_override_reason,
        reason: body.bonus_override_reason,
      },
    });
    if (!bonus.ok) return jsonError(bonus.reason, bonus.status);

    // A skip-agent deposit has no agent bank-match step, so it never starts at
    // "pending_match".
    const skipBot = body.skip_bot ?? true;

    /**
     * A manual deposit is approved the moment it is written.
     *
     * The approve step exists to dispatch a deposit to the agent; with no
     * agent in the loop it was one click that said nothing a human hadn't
     * already said by typing the row. Recording the row IS the approval, so it
     * lands in "processing" with approved_at set.
     *
     * No money moves here — total_deposits, the player's game credit and the
     * company BO pool are all still booked at completion, once CS has really
     * topped up the kiosk. That keeps a top-up that never happened clean:
     * nothing to reverse.
     *
     * A deposit with no game chosen cannot be dispatched to anywhere, so it
     * waits at "pending" exactly as POST /:id/approve would refuse it.
     */
    const autoApprove = skipBot && !!body.selected_game;
    const status = autoApprove
      ? ("processing" as const)
      : skipBot
        ? ("pending" as const)
        : body.status;
    const nowIso = new Date().toISOString();
    const [created] = await db
      .insert(deposits)
      .values({
        transaction_ref: `CRM-${Date.now()}`,
        deposit_date: nowIso,
        player_id: player.player_id,
        player_username: player.username,
        company_entity_id: player.company_entity_id,
        deposit_amount: body.amount,
        bank_name: body.bank_name,
        selected_game: body.selected_game,
        selected_game_username: body.selected_game_username,
        ...bonus.fields,
        status,
        source: "manual",
        skip_bot: skipBot,
        receipt_url: body.receipt_url,
        handled_by_user_id: user.user_id,
        ...(autoApprove ? { approved_at: nowIso } : {}),
        ...(body.assign_to_me
          ? { assigned_to_user_id: user.user_id, assigned_at: nowIso }
          : {}),
        created_at: nowIso,
        updated_at: nowIso,
      })
      .returning();

    await db.insert(transactions).values({
      player_id: player.player_id,
      entity_id: player.company_entity_id,
      type: "deposit",
      amount: body.amount,
      reference_id: created.deposit_id,
      user_id: user.user_id,
      details: {
        source: "manual",
        action: "intent_created",
        status,
        skip_bot: skipBot,
        ...(bonus.plan
          ? {
              bonus: bonus.plan.name,
              bonus_plan_id: bonus.plan.plan_id,
              bonus_amount: bonus.fields.bonus_amount,
              // Present only when a leader/admin forced an ineligible bonus —
              // this is the line an audit reads back.
              ...(bonus.fields.bonus_override_reason
                ? { bonus_override_reason: bonus.fields.bonus_override_reason }
                : {}),
            }
          : {}),
      },
    });

    // The approval, as its own ledger line — the same row POST /:id/approve
    // writes, so the history of an auto-approved deposit reads like any other.
    if (autoApprove) {
      await db.insert(transactions).values({
        player_id: player.player_id,
        entity_id: player.company_entity_id,
        type: "deposit",
        amount: created.total_amount,
        game_name: created.selected_game,
        reference_id: created.deposit_id,
        user_id: user.user_id,
        details: {
          action: "approved_dispatched",
          source: "manual",
          auto: true,
          bonus_percentage: created.bonus_percentage,
        },
      });
    }

    return Response.json({ deposit: created }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

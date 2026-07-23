import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const patchSchema = z.object({
  bonus_percentage: z.number().min(0).max(200).optional(),
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
    }

    const bonusPct = body.bonus_percentage ?? row.bonus_percentage;
    const bonusAmt = +((row.deposit_amount * bonusPct) / 100).toFixed(2);

    const [updated] = await db
      .update(deposits)
      .set({
        ...playerPatch,
        bonus_percentage: bonusPct,
        bonus_amount: bonusAmt,
        total_amount: +(row.deposit_amount + bonusAmt).toFixed(2),
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
      body.bonus_percentage !== undefined &&
      body.bonus_percentage !== row.bonus_percentage
    ) {
      audits.push({
        ...base,
        details: {
          action: "bonus_changed",
          from: row.bonus_percentage,
          to: bonusPct,
          transaction_ref: row.transaction_ref,
        },
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

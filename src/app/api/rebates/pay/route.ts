import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bonusPlans, players, rebatePayouts } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { issueFreeCredit } from "@/lib/free-credit";
import { formatShortDate } from "@/lib/format";

const schema = z.object({
  payouts: z
    .array(
      z.object({
        payout_id: z.number().int().positive(),
        // Override the suggested game / login for this one row.
        game_name: z.string().min(1).max(60).optional(),
        game_username: z.string().max(120).optional(),
      }),
    )
    .min(1)
    .max(500),
  // true = CS already credited the games by hand; false = queue for the agent.
  skip_bot: z.boolean().optional(),
});

/**
 * POST /api/rebates/pay — pay pending rebate rows as free credits, one row at
 * a time so a single bad login doesn't stop the rest. Each success flips the
 * row to "paid" with the credit's transfer/ledger ids; each failure is
 * reported back against its payout id and the row stays pending.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Provide payouts to pay");
    const skipBot = parsed.data.skip_bot ?? false;

    let paid = 0;
    let total = 0;
    const failed: Array<{ payout_id: number; error: string }> = [];
    const planNames = new Set<string>();
    let companyEntityId: number | null = null;

    for (const item of parsed.data.payouts) {
      try {
        await db.transaction(async (txn) => {
          const [row] = await txn
            .select({ payout: rebatePayouts, plan: bonusPlans, player: players })
            .from(rebatePayouts)
            .innerJoin(bonusPlans, eq(bonusPlans.plan_id, rebatePayouts.plan_id))
            .innerJoin(players, eq(players.player_id, rebatePayouts.player_id))
            .where(eq(rebatePayouts.payout_id, item.payout_id))
            .for("update");
          if (!row) throw new AuthError(404, "Payout not found");
          const { payout, plan, player } = row;
          if (
            user.companyIds !== null &&
            !user.companyIds.includes(player.company_entity_id)
          ) {
            throw new AuthError(403, "Player is outside your company scope");
          }
          if (payout.status === "paid") throw new AuthError(409, "Already paid");
          if (payout.status === "skipped") throw new AuthError(409, "Skipped — unskip it first");

          const gameName = item.game_name ?? payout.game_name;
          if (!gameName) {
            throw new AuthError(422, `${player.username} has no game account to credit`);
          }
          const gameUsername =
            item.game_name !== undefined ? item.game_username : (item.game_username ?? payout.game_username);

          const issued = await issueFreeCredit(txn, {
            user,
            player,
            gameName,
            gameUsername,
            amount: payout.amount,
            reason: `Rebate — ${plan.name}, ${formatShortDate(payout.window_start)} to ${formatShortDate(
              payout.window_end,
            )}`,
            skipBot,
            details: { rebate_payout_id: payout.payout_id, rebate_plan_id: plan.plan_id },
          });

          await txn
            .update(rebatePayouts)
            .set({
              status: "paid",
              game_name: gameName,
              game_username: issued.gameUsername,
              skip_bot: skipBot,
              game_transfer_id: issued.gameTransferId,
              transaction_id: issued.transactionId,
              paid_by_user_id: user.user_id,
              paid_at: new Date().toISOString(),
            })
            .where(and(eq(rebatePayouts.payout_id, payout.payout_id), eq(rebatePayouts.status, "pending")));

          paid++;
          total += payout.amount;
          planNames.add(plan.name);
          companyEntityId = plan.company_entity_id ?? player.company_entity_id;
        });
      } catch (e) {
        failed.push({
          payout_id: item.payout_id,
          error: e instanceof AuthError ? e.message : "Could not pay this rebate",
        });
        if (!(e instanceof AuthError)) console.error(e);
      }
    }

    if (paid) {
      await logActivity({
        category: "bonus",
        action: "rebate.paid",
        summary: `${paid} rebate${paid === 1 ? "" : "s"} paid (RM ${total.toFixed(2)}) for ${[
          ...planNames,
        ].join(", ")}${skipBot ? " — credited by hand" : " — queued for the agent"}`,
        actor: user,
        companyEntityId,
        targetType: "rebate_payout",
        context: { paid, total: +total.toFixed(2), skip_bot: skipBot, failed: failed.length },
      });
    }

    return Response.json({ paid, total: +total.toFixed(2), failed });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

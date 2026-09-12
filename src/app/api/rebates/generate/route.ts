import { z } from "zod";
import { authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import {
  generateRebateList,
  loadRebateCutoffs,
  loadRebatePlanForUser,
  rebatePlanData,
} from "@/lib/rebates";

const schema = z.object({
  plan_id: z.number().int().positive(),
  // The end cutoff of the window to build. Omit for the latest closed one.
  window_end: z.string().optional(),
});

/**
 * POST /api/rebates/generate — snapshot a closed window of a rebate plan into
 * payout rows: the latest by default, or an earlier one named by `window_end`.
 * Re-running before anything is paid replaces the list; once a row is paid
 * the window is frozen (409).
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Provide plan_id");
    const plan = await loadRebatePlanForUser(user, parsed.data.plan_id);
    const cutoffs = await loadRebateCutoffs();

    let windowEnd: Date | undefined;
    if (parsed.data.window_end !== undefined) {
      windowEnd = new Date(parsed.data.window_end);
      if (Number.isNaN(windowEnd.getTime())) return jsonError("Bad window_end");
    }
    const result = await generateRebateList(plan, cutoffs, user, new Date(), windowEnd);
    if (!result.ok) return jsonError(result.reason, result.status);

    await logActivity({
      category: "bonus",
      action: "rebate.generated",
      summary: `Rebate list generated for "${plan.name}": ${result.inserted} player${
        result.inserted === 1 ? "" : "s"
      } (${result.window.start.toISOString()} → ${result.window.end.toISOString()})${
        result.replaced ? `, replacing ${result.replaced} unpaid rows` : ""
      }`,
      actor: user,
      companyEntityId: plan.company_entity_id,
      targetType: "bonus_plan",
      targetId: plan.plan_id,
      targetLabel: plan.name,
      context: {
        window_start: result.window.start.toISOString(),
        window_end: result.window.end.toISOString(),
        inserted: result.inserted,
        replaced: result.replaced,
      },
    });

    const data = await rebatePlanData(
      plan,
      cutoffs,
      user.companyIds,
      result.window.start.toISOString(),
    );
    return Response.json({ ...data, inserted: result.inserted, replaced: result.replaced });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

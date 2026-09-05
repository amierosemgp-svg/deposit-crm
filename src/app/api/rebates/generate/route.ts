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

const schema = z.object({ plan_id: z.number().int().positive() });

/**
 * POST /api/rebates/generate — snapshot the latest closed window of a rebate
 * plan into payout rows. Re-running before anything is paid replaces the
 * list; once a row is paid the window is frozen (409).
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Provide plan_id");
    const plan = await loadRebatePlanForUser(user, parsed.data.plan_id);
    const cutoffs = await loadRebateCutoffs();

    const result = await generateRebateList(plan, cutoffs, user);
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

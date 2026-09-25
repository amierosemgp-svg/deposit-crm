import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, claims, entities, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";

const createSchema = z.object({
  entity_id: z.number().int().positive(),
  claimed_by_user_id: z.number().int().positive(),
  paid_into_account_id: z.number().int().positive().nullable().optional(),
  amount: z.number().positive(),
  occurred_at: z.string().min(1),
  reason: z.string().min(1).max(200),
  notes: z.string().optional(),
});

/**
 * POST /api/claims — record money someone put in that the company owes back.
 *
 * Deliberately does **not** move a bank balance. The money arrived when the
 * claimant paid it; whatever it funded is already in the account, counted by
 * whichever row recorded the funding. Booking it again here would credit the
 * same ringgit twice. A claim is a liability, and it stays one until it is
 * settled — that is the step that moves money, in /api/claims/[id].
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const isAdmin = user.role === "super_admin";
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    }
    const body = parsed.data;

    // Whose debt it is has to be a company, and one this user works for.
    const [company] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, body.entity_id));
    if (!company) return jsonError("Company not found", 404);
    if (company.entity_type !== "company") {
      return jsonError(`Entity ${body.entity_id} is not a company`);
    }
    if (!isAdmin && user.companyIds !== null && !user.companyIds.includes(body.entity_id)) {
      throw new AuthError(403, "Record the claim against one of your own companies");
    }

    const [claimant] = await db
      .select()
      .from(users)
      .where(eq(users.user_id, body.claimed_by_user_id));
    if (!claimant) return jsonError("Claimant not found", 404);

    /**
     * CS records these, not just admins.
     *
     * The money usually goes in before anyone senior hears about it — the boss
     * pays an agent, tells the desk, and the desk writes it down. Requiring an
     * admin to enter it would mean the debt sits unrecorded until someone gets
     * round to it, which is how it ended up buried in Clear Bank in the first
     * place.
     *
     * Recording a claim is not the risk; paying one is. Settling stays
     * admin-only, so the worst a wrong entry does here is show a debt that an
     * admin then declines to settle. The company it is booked against is still
     * scoped to the companies this user actually works for, above.
     */

    if (body.paid_into_account_id != null) {
      const [account] = await db
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, body.paid_into_account_id));
      if (!account) return jsonError("Bank account not found", 404);
      if (user.ownedEntityIds !== null && !user.ownedEntityIds.includes(account.entity_id)) {
        throw new AuthError(403, "That bank account is outside your organisation");
      }
    }

    const [created] = await db
      .insert(claims)
      .values({
        entity_id: body.entity_id,
        claimed_by_user_id: body.claimed_by_user_id,
        paid_into_account_id: body.paid_into_account_id ?? null,
        amount: body.amount,
        occurred_at: body.occurred_at,
        reason: body.reason,
        notes: body.notes ?? null,
        recorded_by_user_id: user.user_id,
      })
      .returning();

    await logActivity({
      category: "expense",
      action: "claim.created",
      summary: `Claim recorded: ${claimant.username} is owed RM ${created.amount.toFixed(2)} — ${created.reason}`,
      actor: user,
      companyEntityId: created.entity_id,
      targetType: "claim",
      targetId: created.claim_id,
      targetLabel: created.reason,
      context: { amount: created.amount, claimed_by: claimant.username },
    });

    return Response.json({ claim: created }, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

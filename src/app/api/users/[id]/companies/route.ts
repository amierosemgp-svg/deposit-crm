import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, leaderMemberships, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError, isUniqueViolation } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";

/**
 * Which companies a leader holds.
 *
 * Vocabulary: a `leader` entity is a COMPANY on screen (Abdullah Club, ICON); a
 * `company` entity is a casino (Pokercity). A *leader* is the person.
 *
 * users.entity_id is the company they were created under and is always theirs;
 * leader_memberships holds the rest. So the set is "the one they sit on, plus
 * the ones granted", and the one they sit on can never be revoked here — moving
 * that is a different operation with different consequences.
 */

const bodySchema = z.object({
  action: z.enum(["grant", "revoke"]),
  leader_entity_id: z.number().int().positive(),
});

async function loadTarget(
  requester: Awaited<ReturnType<typeof requireWriteUser>>,
  targetId: number,
) {
  if (requester.role !== "super_admin") {
    throw new AuthError(403, "Only admins change which companies a leader holds");
  }
  const [target] = await db.select().from(users).where(eq(users.user_id, targetId));
  if (!target) throw new AuthError(404, "User not found");
  if (target.role !== "company_leader") {
    throw new AuthError(422, "Only a leader can hold companies");
  }
  return target;
}

/** GET — the companies this leader holds, the one they sit on marked. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const requester = await requireWriteUser();
    const target = await loadTarget(requester, Number((await params).id));

    const rows = await db
      .select({ leader_entity_id: leaderMemberships.leader_entity_id })
      .from(leaderMemberships)
      .where(eq(leaderMemberships.user_id, target.user_id));

    return Response.json({
      home_entity_id: target.entity_id,
      leader_entity_ids: [
        ...new Set([target.entity_id, ...rows.map((r) => r.leader_entity_id)]),
      ],
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/** POST — grant or revoke one company. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const requester = await requireWriteUser();
    const target = await loadTarget(requester, Number((await params).id));
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const { action, leader_entity_id } = parsed.data;

    const [company] = await db
      .select()
      .from(entities)
      .where(eq(entities.entity_id, leader_entity_id));
    if (!company) return jsonError("Company not found", 404);
    if (company.entity_type !== "leader") {
      return jsonError("That entity is not a company", 422);
    }
    // Both ends inside the admin's own organisation.
    if (requester.ownedEntityIds !== null && !requester.ownedEntityIds.includes(leader_entity_id)) {
      throw new AuthError(403, "That company belongs to another organisation");
    }

    if (action === "grant") {
      if (target.entity_id === leader_entity_id) {
        return jsonError("They already sit on that company", 422);
      }
      try {
        await db.insert(leaderMemberships).values({
          user_id: target.user_id,
          leader_entity_id,
          granted_by_user_id: requester.user_id,
        });
      } catch (e) {
        // Granting twice is the same grant, not an error.
        if (!isUniqueViolation(e)) throw e;
      }
    } else {
      if (target.entity_id === leader_entity_id) {
        return jsonError(
          "That is the company they were created under — it cannot be taken away here",
          422,
        );
      }
      await db
        .delete(leaderMemberships)
        .where(
          and(
            eq(leaderMemberships.user_id, target.user_id),
            eq(leaderMemberships.leader_entity_id, leader_entity_id),
          ),
        );
    }

    await logActivity({
      category: "user",
      action: `leader.company_${action}ed`,
      summary:
        `${target.username} ${action === "grant" ? "given" : "taken off"} ${company.name}`,
      actor: requester,
      targetType: "user",
      targetId: target.user_id,
      targetLabel: target.username,
      context: { leader_entity_id, company: company.name },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

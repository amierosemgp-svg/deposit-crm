import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { companyLeaders, entities, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { assignCompanyToLeader, companiesOfLeader } from "@/lib/company-leaders";

/**
 * POST /api/leaders/:id/restructure — a leader stops running their companies.
 *
 *   merge     — another leader takes the lot, and this one is retired.
 *   downgrade — same hand-over, but the leader's own logins are deactivated
 *               too: they are not running anything any more.
 *
 * Both are the same movement underneath, and neither deletes anything. The
 * leader entity stays, its closed ownership rows stay, and every past report
 * still attributes August to whoever actually held the company in August. A
 * leader who is retired is a leader with no live ownership rows — not a
 * missing row that breaks every join pointing at it.
 */

const bodySchema = z.object({
  action: z.enum(["merge", "downgrade"]),
  /** Who takes the companies. Required: they cannot be left with nobody. */
  to_leader_entity_id: z.number().int().positive(),
  note: z.string().max(300).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    if (user.role !== "super_admin") {
      throw new AuthError(403, "Only admins restructure leaders");
    }
    const fromId = Number((await params).id);
    if (!Number.isInteger(fromId)) return jsonError("Bad leader id");

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const body = parsed.data;
    if (fromId === body.to_leader_entity_id) {
      return jsonError("Pick a different leader to take the companies");
    }

    const rows = await db
      .select({ id: entities.entity_id, name: entities.name, type: entities.entity_type })
      .from(entities)
      .where(inArray(entities.entity_id, [fromId, body.to_leader_entity_id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const from = byId.get(fromId);
    const to = byId.get(body.to_leader_entity_id);
    if (!from || from.type !== "leader") return jsonError("Not a leader", 404);
    if (!to || to.type !== "leader") return jsonError("Target is not a leader", 404);

    if (user.ownedEntityIds !== null) {
      for (const id of [fromId, body.to_leader_entity_id]) {
        if (!user.ownedEntityIds.includes(id)) {
          throw new AuthError(403, "That leader belongs to another organisation");
        }
      }
    }

    const moved = await db.transaction(async (txn) => {
      const companies = await companiesOfLeader(fromId, undefined, txn);

      for (const companyId of companies) {
        // Hand it over first, so the company is never momentarily ownerless —
        // and so endCompanyLeader's "last leader" guard has somewhere to move
        // the primary flag to.
        await assignCompanyToLeader(
          {
            companyEntityId: companyId,
            leaderEntityId: body.to_leader_entity_id,
            primary: true,
            note: body.note ?? `${body.action} from ${from.name}`,
            byUserId: user.user_id,
          },
          txn,
        );
      }

      // Close every row this leader held. Closed, not deleted: these rows are
      // the evidence for what the reports already said.
      const nowIso = new Date().toISOString();
      await txn
        .update(companyLeaders)
        .set({ valid_to: nowIso })
        .where(
          and(
            eq(companyLeaders.leader_entity_id, fromId),
            isNull(companyLeaders.valid_to),
          ),
        );

      await txn
        .update(entities)
        .set({ status: "inactive" })
        .where(eq(entities.entity_id, fromId));

      // A downgraded leader should not still be able to sign in and act as one.
      if (body.action === "downgrade") {
        await txn
          .update(users)
          .set({ status: "inactive" })
          .where(eq(users.entity_id, fromId));
      }

      return companies.length;
    });

    await logActivity({
      category: "entity",
      action: `leader.${body.action}`,
      summary:
        `${from.name} ${body.action === "merge" ? "merged into" : "downgraded to"} ` +
        `${to.name} — ${moved} ${moved === 1 ? "company" : "companies"} moved`,
      actor: user,
      targetType: "entity",
      targetId: fromId,
      targetLabel: from.name,
      context: { to: to.name, companies_moved: moved, note: body.note ?? null },
    });

    return Response.json({ ok: true, companies_moved: moved });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

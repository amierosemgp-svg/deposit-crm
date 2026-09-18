import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { companyLeaders, entities } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import {
  assignCompanyToLeader,
  endCompanyLeader,
  setPrimaryLeader,
} from "@/lib/company-leaders";

/**
 * Who runs which company.
 *
 * GET  — the ownership record, current rows and closed ones alike, so a past
 *        report's attribution can be explained rather than just asserted.
 * POST — hand a company to a leader, take it away, or move the primary flag.
 *
 * Admin-only to write: this is the line the whole scope system is drawn from,
 * and a leader able to hand themselves another leader's company would walk
 * straight through it.
 */

const bodySchema = z.object({
  action: z.enum(["assign", "end", "set_primary"]),
  company_entity_id: z.number().int().positive(),
  leader_entity_id: z.number().int().positive(),
  primary: z.boolean().optional(),
  note: z.string().max(300).optional(),
});

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sp = new URL(request.url).searchParams;
    const companyId = Number(sp.get("company")) || null;
    const leaderId = Number(sp.get("leader")) || null;
    // History is off by default: the ownership screens want what is in force,
    // and the closed rows are only interesting when explaining a past report.
    const includeClosed = sp.get("history") === "1";

    const where = [
      companyId ? eq(companyLeaders.company_entity_id, companyId) : undefined,
      leaderId ? eq(companyLeaders.leader_entity_id, leaderId) : undefined,
      includeClosed ? undefined : isNull(companyLeaders.valid_to),
      // Scoped like everything else: a leader sees their own organisation's
      // ownership, not another tenant's.
      user.ownedEntityIds === null
        ? undefined
        : inArray(companyLeaders.company_entity_id, user.ownedEntityIds),
    ].filter(Boolean);

    const rows = await db
      .select()
      .from(companyLeaders)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(companyLeaders.valid_from))
      .limit(2000);

    return Response.json({ company_leaders: rows });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    if (user.role !== "super_admin") {
      throw new AuthError(403, "Only admins change who runs a company");
    }
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const body = parsed.data;

    const rows = await db
      .select({ id: entities.entity_id, name: entities.name, type: entities.entity_type })
      .from(entities)
      .where(inArray(entities.entity_id, [body.company_entity_id, body.leader_entity_id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const company = byId.get(body.company_entity_id);
    const leader = byId.get(body.leader_entity_id);
    if (!company) return jsonError("Company not found", 404);
    if (!leader) return jsonError("Leader not found", 404);

    // Both ends inside the admin's own organisation — assertSameOrganisation
    // checks they match each other, this checks they are the admin's to move.
    if (user.ownedEntityIds !== null) {
      for (const id of [body.company_entity_id, body.leader_entity_id]) {
        if (!user.ownedEntityIds.includes(id)) {
          throw new AuthError(403, "That entity belongs to another organisation");
        }
      }
    }

    await db.transaction(async (txn) => {
      if (body.action === "assign") {
        await assignCompanyToLeader(
          {
            companyEntityId: body.company_entity_id,
            leaderEntityId: body.leader_entity_id,
            primary: body.primary,
            note: body.note ?? null,
            byUserId: user.user_id,
          },
          txn,
        );
      } else if (body.action === "end") {
        await endCompanyLeader(body.company_entity_id, body.leader_entity_id, txn);
      } else {
        await setPrimaryLeader(body.company_entity_id, body.leader_entity_id, txn);
      }
    });

    const verb = {
      assign: "handed to",
      end: "taken from",
      set_primary: "set primary under",
    }[body.action];
    await logActivity({
      category: "entity",
      action: `company_leader.${body.action}`,
      summary: `${company.name} ${verb} ${leader.name}`,
      actor: user,
      companyEntityId: body.company_entity_id,
      targetType: "company_leader",
      targetId: body.company_entity_id,
      targetLabel: company.name,
      context: { leader: leader.name, note: body.note ?? null },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

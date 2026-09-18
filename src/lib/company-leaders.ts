import { and, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { companyLeaders, entities } from "@/db/schema";
import { AuthError } from "@/lib/auth";

/**
 * Who runs a company, and who ran it then.
 *
 * `entities.parent_entity_id` still names a company's *primary* leader so the
 * hierarchy has a spine, but it is a pointer, not the record. This module is
 * the record: every hand-off closes a row and opens another, so ownership can
 * be read back for any date rather than only for today.
 *
 * Every write goes through here. Two call sites maintaining the primary flag
 * and the tree pointer separately is how a company ends up drawn under one
 * leader and scoped to another.
 */

type Tx = Pick<typeof db, "select" | "insert" | "update">;

/** Ownership rows in force at an instant; omit `at` for right now. */
export function validAt(at?: string): SQL {
  if (!at) return isNull(companyLeaders.valid_to);
  return and(
    sql`${companyLeaders.valid_from} <= ${at}`,
    or(isNull(companyLeaders.valid_to), gt(companyLeaders.valid_to, at))!,
  )!;
}

/** Company ids a leader ran at `at` (default: now). */
export async function companiesOfLeader(
  leaderEntityId: number,
  at?: string,
  runner: Tx = db,
): Promise<number[]> {
  const rows = await runner
    .select({ id: companyLeaders.company_entity_id })
    .from(companyLeaders)
    .where(and(eq(companyLeaders.leader_entity_id, leaderEntityId), validAt(at)));
  return [...new Set(rows.map((r) => r.id))];
}

/** Leader ids running a company at `at` (default: now). */
export async function leadersOfCompany(
  companyEntityId: number,
  at?: string,
  runner: Tx = db,
): Promise<number[]> {
  const rows = await runner
    .select({ id: companyLeaders.leader_entity_id })
    .from(companyLeaders)
    .where(and(eq(companyLeaders.company_entity_id, companyEntityId), validAt(at)));
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * Hand a company to a leader.
 *
 * Idempotent: handing it to a leader who already runs it changes nothing
 * rather than opening a second live row, which the unique index would refuse
 * anyway. Making it primary demotes whichever row held that flag and moves the
 * tree pointer to match, so the two can never disagree.
 */
export async function assignCompanyToLeader(
  input: {
    companyEntityId: number;
    leaderEntityId: number;
    primary?: boolean;
    note?: string | null;
    byUserId?: number | null;
  },
  runner: Tx = db,
): Promise<void> {
  const { companyEntityId, leaderEntityId } = input;
  await assertSameOrganisation(companyEntityId, leaderEntityId, runner);

  const [existing] = await runner
    .select()
    .from(companyLeaders)
    .where(
      and(
        eq(companyLeaders.company_entity_id, companyEntityId),
        eq(companyLeaders.leader_entity_id, leaderEntityId),
        isNull(companyLeaders.valid_to),
      ),
    );

  if (!existing) {
    await runner.insert(companyLeaders).values({
      company_entity_id: companyEntityId,
      leader_entity_id: leaderEntityId,
      is_primary: false,
      note: input.note ?? null,
      created_by_user_id: input.byUserId ?? null,
    });
  }

  if (input.primary) await setPrimaryLeader(companyEntityId, leaderEntityId, runner);
}

/**
 * Stop a leader running a company: the row is closed, never deleted, because
 * it is the only evidence of who was responsible while it was open.
 *
 * Refuses to leave a company with nobody — a company whose last leader walks
 * away is invisible to every leader-scoped screen, which reads as data loss.
 */
export async function endCompanyLeader(
  companyEntityId: number,
  leaderEntityId: number,
  runner: Tx = db,
): Promise<void> {
  const current = await leadersOfCompany(companyEntityId, undefined, runner);
  if (!current.includes(leaderEntityId)) return;
  if (current.length === 1) {
    throw new AuthError(
      422,
      "That is the company's only leader — hand it to someone else first",
    );
  }

  const nowIso = new Date().toISOString();
  const [closed] = await runner
    .update(companyLeaders)
    .set({ valid_to: nowIso })
    .where(
      and(
        eq(companyLeaders.company_entity_id, companyEntityId),
        eq(companyLeaders.leader_entity_id, leaderEntityId),
        isNull(companyLeaders.valid_to),
      ),
    )
    .returning();

  // The primary just left; promote one of the remaining leaders so the tree
  // still has somewhere to draw this company.
  if (closed?.is_primary) {
    const next = current.find((id) => id !== leaderEntityId);
    if (next) await setPrimaryLeader(companyEntityId, next, runner);
  }
}

/** Move the primary flag, and the tree pointer with it. */
export async function setPrimaryLeader(
  companyEntityId: number,
  leaderEntityId: number,
  runner: Tx = db,
): Promise<void> {
  await runner
    .update(companyLeaders)
    .set({ is_primary: false })
    .where(
      and(
        eq(companyLeaders.company_entity_id, companyEntityId),
        isNull(companyLeaders.valid_to),
      ),
    );
  await runner
    .update(companyLeaders)
    .set({ is_primary: true })
    .where(
      and(
        eq(companyLeaders.company_entity_id, companyEntityId),
        eq(companyLeaders.leader_entity_id, leaderEntityId),
        isNull(companyLeaders.valid_to),
      ),
    );
  await runner
    .update(entities)
    .set({ parent_entity_id: leaderEntityId })
    .where(eq(entities.entity_id, companyEntityId));
}

/**
 * Both ends must sit under the same main company.
 *
 * Sharing a company across organisations would hand one tenant's deposits,
 * players and bank accounts to the other's leader — the boundary the scope
 * rules exist to hold.
 */
async function assertSameOrganisation(
  companyEntityId: number,
  leaderEntityId: number,
  runner: Tx = db,
): Promise<void> {
  const all = await runner
    .select({ id: entities.entity_id, parent: entities.parent_entity_id, type: entities.entity_type })
    .from(entities);
  const byId = new Map(all.map((e) => [e.id, e]));

  const company = byId.get(companyEntityId);
  const leader = byId.get(leaderEntityId);
  if (!company || company.type !== "company") {
    throw new AuthError(404, "Company not found");
  }
  if (!leader || leader.type !== "leader") {
    throw new AuthError(422, "That entity is not a leader");
  }

  const rootOf = (startId: number) => {
    let node = byId.get(startId);
    for (let hops = 0; node?.parent && hops < 20; hops++) {
      node = byId.get(node.parent) ?? node;
    }
    return node?.id ?? startId;
  };
  // The company's root is read through its leader: its own parent pointer is
  // about to move, and mid-reassignment it may not agree with anything yet.
  if (rootOf(leaderEntityId) !== rootOf(company.parent ?? leaderEntityId)) {
    throw new AuthError(403, "Company and leader belong to different organisations");
  }
}

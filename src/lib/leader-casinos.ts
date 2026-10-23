import { inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { companyLeaders, entities, leaderMemberships, users } from "@/db/schema";

type Txn = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = typeof db | Txn;

export type LeaderCasino = { id: number; name: string };

/**
 * The casinos each leader runs: every company under a group they sit on or
 * were granted, plus any company still linked to one of those groups.
 *
 * A leader transfer names a person, and one person can hold many casinos —
 * Jeffery OK sits on seven groups. Which of them a settlement is for is what
 * decides who sees it, so the sheet offers exactly this list for each end.
 */
export async function casinosOfLeaders(
  reader: Reader,
  userIds: number[],
): Promise<Map<number, LeaderCasino[]>> {
  const out = new Map<number, LeaderCasino[]>();
  if (!userIds.length) return out;
  const [people, held, all, links] = await Promise.all([
    reader
      .select({ user_id: users.user_id, entity_id: users.entity_id })
      .from(users)
      .where(inArray(users.user_id, userIds)),
    reader
      .select({ user_id: leaderMemberships.user_id, id: leaderMemberships.leader_entity_id })
      .from(leaderMemberships)
      .where(inArray(leaderMemberships.user_id, userIds)),
    reader
      .select({
        id: entities.entity_id,
        name: entities.name,
        type: entities.entity_type,
        parent: entities.parent_entity_id,
      })
      .from(entities),
    reader
      .select({ company: companyLeaders.company_entity_id, leader: companyLeaders.leader_entity_id })
      .from(companyLeaders)
      .where(isNull(companyLeaders.valid_to)),
  ]);
  const companies = all.filter((e) => e.type === "company");
  for (const p of people) {
    const groups = new Set([p.entity_id, ...held.filter((h) => h.user_id === p.user_id).map((h) => h.id)]);
    const ids = new Set<number>();
    for (const c of companies) {
      if (groups.has(c.id) || (c.parent !== null && groups.has(c.parent))) ids.add(c.id);
    }
    for (const l of links) if (groups.has(l.leader)) ids.add(l.company);
    out.set(
      p.user_id,
      companies
        .filter((c) => ids.has(c.id))
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
  return out;
}

/**
 * The casino one end of a settlement is for.
 *
 * Filled in for the desk wherever it can be: a named account that sits on a
 * casino says which one, and a leader with a single casino has no choice to
 * make. Only an end paid in cash or by bank transfer, for a leader holding
 * several casinos, has to be picked by hand.
 */
export function resolveEndCasino(input: {
  side: "From" | "To";
  personName: string;
  casinos: LeaderCasino[];
  picked: number | null | undefined;
  /** Entity of the bank account named on this end, if any. */
  accountEntityId: number | null;
}): { ok: true; id: number | null } | { ok: false; error: string } {
  const { side, personName, casinos, picked, accountEntityId } = input;
  const fromAccount =
    accountEntityId !== null ? casinos.find((c) => c.id === accountEntityId) : undefined;
  if (picked != null) {
    if (!casinos.some((c) => c.id === picked)) {
      return { ok: false, error: `${side} casino is not one ${personName} runs` };
    }
    if (fromAccount && fromAccount.id !== picked) {
      return {
        ok: false,
        error: `${side} account belongs to ${fromAccount.name}, not the ${side.toLowerCase()} casino picked`,
      };
    }
    return { ok: true, id: picked };
  }
  if (fromAccount) return { ok: true, id: fromAccount.id };
  if (casinos.length === 1) return { ok: true, id: casinos[0].id };
  if (casinos.length === 0) return { ok: true, id: null };
  return {
    ok: false,
    error: `${personName} runs ${casinos.length} casinos — pick which one in ${side} Casino`,
  };
}

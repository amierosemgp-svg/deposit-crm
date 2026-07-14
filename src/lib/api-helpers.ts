import { and, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  bankAccounts,
  bankTransfers,
  deposits,
  entities,
  settings,
  transactions,
} from "@/db/schema";
import type { AuthedUser } from "./auth";

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

/** SQL filter for deposit visibility under the user's scope. */
export function depositScopeFilter(user: AuthedUser): SQL | undefined {
  if (user.companyIds === null) return undefined;
  if (!user.companyIds.length) return isNull(deposits.company_entity_id);
  return or(
    inArray(deposits.company_entity_id, user.companyIds),
    isNull(deposits.company_entity_id),
  );
}

/** Entity IDs whose bank accounts / players / BO accounts the user can see. */
export async function visibleEntityIds(user: AuthedUser): Promise<number[] | null> {
  if (user.companyIds === null) return null; // unrestricted
  if (user.role === "company_leader") {
    return [user.entity_id, ...user.companyIds];
  }
  return user.companyIds; // cs_agent: just their company
}

/** Full entity subtree visible to the user (for hierarchy page). */
export async function visibleEntityTree(user: AuthedUser) {
  const all = await db.select().from(entities);
  if (user.companyIds === null) return all;

  const roots =
    user.role === "company_leader" ? [user.entity_id] : [...user.companyIds];
  const byId = new Map(all.map((e) => [e.entity_id, e]));

  // 1. The user's own subtree: roots + everything descending from them.
  const subtree = new Set<number>(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of all) {
      if (
        e.parent_entity_id &&
        subtree.has(e.parent_entity_id) &&
        !subtree.has(e.entity_id)
      ) {
        subtree.add(e.entity_id);
        grew = true;
      }
    }
  }

  // 2. Ancestors of the roots — for display context only (NOT their other children).
  const keep = new Set<number>(subtree);
  for (const rootId of roots) {
    let cur = byId.get(rootId)?.parent_entity_id
      ? byId.get(byId.get(rootId)!.parent_entity_id!)
      : undefined;
    while (cur) {
      keep.add(cur.entity_id);
      cur = cur.parent_entity_id ? byId.get(cur.parent_entity_id) : undefined;
    }
  }
  return all.filter((e) => keep.has(e.entity_id));
}

/**
 * Bank-transfer authorization rule, checked against the entity tree:
 *  1. company → company with the same parent leader
 *  2. leader → a company that is the leader's own direct child
 */
export async function transferAllowed(
  fromEntityId: number,
  toEntityId: number,
): Promise<{ allowed: boolean; reason?: string }> {
  if (fromEntityId === toEntityId) {
    return { allowed: true }; // internal rebalance between own accounts
  }
  const rows = await db
    .select()
    .from(entities)
    .where(inArray(entities.entity_id, [fromEntityId, toEntityId]));
  const from = rows.find((e) => e.entity_id === fromEntityId);
  const to = rows.find((e) => e.entity_id === toEntityId);
  if (!from || !to) return { allowed: false, reason: "Entity not found" };

  if (
    from.entity_type === "company" &&
    to.entity_type === "company" &&
    from.parent_entity_id === to.parent_entity_id
  ) {
    return { allowed: true };
  }
  if (
    from.entity_type === "leader" &&
    to.entity_type === "company" &&
    to.parent_entity_id === from.entity_id
  ) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      "Transfers are only allowed between companies under the same leader, or from a leader to their own company",
  };
}

export async function getSettingNumber(key: string, fallback: number) {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : fallback;
}

/** Credit recipients of expired pending transfers (lazy sweep + cron both call this). */
export async function autoConfirmExpiredTransfers(): Promise<number> {
  const nowIso = new Date().toISOString();
  const expired = await db
    .select()
    .from(bankTransfers)
    .where(
      and(
        eq(bankTransfers.status, "pending_confirmation"),
        lt(bankTransfers.expires_at, nowIso),
      ),
    );
  for (const t of expired) {
    await db.transaction(async (txn) => {
      const [locked] = await txn
        .select()
        .from(bankTransfers)
        .where(
          and(
            eq(bankTransfers.transfer_id, t.transfer_id),
            eq(bankTransfers.status, "pending_confirmation"),
          ),
        )
        .for("update");
      if (!locked) return;
      const [toAccount] = await txn
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, t.to_account_id))
        .for("update");
      await txn
        .update(bankAccounts)
        .set({
          current_balance: +(toAccount.current_balance + t.amount).toFixed(2),
        })
        .where(eq(bankAccounts.account_id, t.to_account_id));
      await txn
        .update(bankTransfers)
        .set({ status: "auto_confirmed", confirmed_at: nowIso })
        .where(eq(bankTransfers.transfer_id, t.transfer_id));
      await txn.insert(transactions).values({
        type: "bank_transfer",
        amount: t.amount,
        reference_id: t.transfer_id,
        details: { action: "auto_confirmed", reason: "confirmation window expired" },
      });
    });
  }
  return expired.length;
}

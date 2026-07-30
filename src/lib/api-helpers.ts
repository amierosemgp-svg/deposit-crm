import { and, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  bankAccounts,
  bankTransfers,
  deposits,
  entities,
  gameTransfers,
  settings,
  transactions,
} from "@/db/schema";
import type { AuthedUser } from "./auth";
import { MAX_TRANSFER_ATTEMPTS, STUCK_TRANSFER_MS } from "./types";

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
        // Manual (skip-bot) transfers never auto-confirm — a human decides.
        eq(bankTransfers.skip_bot, false),
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
        entity_id: toAccount.entity_id,
        type: "bank_transfer",
        amount: t.amount,
        reference_id: t.transfer_id,
        details: { action: "auto_confirmed", reason: "confirmation window expired" },
      });
    });
  }
  return expired.length;
}

/**
 * Restart game transfers the bot has gone quiet on.
 *
 * A transfer sits in "processing" from the moment CS requests it until the bot
 * reports back. When many land at once the bot can drop one — and nothing else
 * ever moves it, so CS watches a transfer hang forever. This sweep restarts the
 * clock on anything quiet for STUCK_TRANSFER_MS, which puts it back at the head
 * of the bot's `?status=processing` queue for another attempt, and fails it with
 * a reason once it has burned through MAX_TRANSFER_ATTEMPTS.
 *
 * No credits move here either way: a "processing" transfer hasn't moved any yet.
 *
 * Runs lazily on every /api/state read (CS has the page open, so it self-heals
 * while anyone is watching) and from the cron as a safety net.
 */
export async function retryStuckGameTransfers(): Promise<{
  restarted: number;
  failed: number;
}> {
  const nowIso = new Date().toISOString();
  const cutoff = new Date(Date.now() - STUCK_TRANSFER_MS).toISOString();

  const stuck = await db
    .select()
    .from(gameTransfers)
    .where(
      and(
        eq(gameTransfers.status, "processing"),
        // started_at is backfilled for every row, but fall back to created_at
        // so a transfer can never dodge the sweep by having a null start.
        or(
          lt(gameTransfers.started_at, cutoff),
          and(
            isNull(gameTransfers.started_at),
            lt(gameTransfers.created_at, cutoff),
          ),
        ),
      ),
    );

  let restarted = 0;
  let failed = 0;

  for (const t of stuck) {
    await db.transaction(async (txn) => {
      // Re-read under a lock: the bot may have reported back in the meantime,
      // in which case this transfer is no longer ours to touch.
      const [locked] = await txn
        .select()
        .from(gameTransfers)
        .where(
          and(
            eq(gameTransfers.transfer_id, t.transfer_id),
            eq(gameTransfers.status, "processing"),
          ),
        )
        .for("update");
      if (!locked) return;

      const attempts = locked.attempt_count ?? 1;

      if (attempts >= MAX_TRANSFER_ATTEMPTS) {
        await txn
          .update(gameTransfers)
          .set({
            status: "failed",
            completed_at: nowIso,
            note: `Gave up after ${attempts} attempts — the bot never reported back. No credits were moved; retry the transfer or move it in the provider back-office by hand.`,
          })
          .where(eq(gameTransfers.transfer_id, t.transfer_id));
        await txn.insert(transactions).values({
          player_id: locked.player_id,
          type: "game_transfer",
          amount: locked.transfer_amount,
          game_name: `${locked.from_game} → ${locked.to_game}`,
          reference_id: locked.transfer_id,
          details: {
            source: "system",
            action: "failed",
            reason: "no bot response",
            attempts,
          },
        });
        failed += 1;
        return;
      }

      await txn
        .update(gameTransfers)
        .set({
          attempt_count: attempts + 1,
          // Restarting the clock is what re-queues it: the bot polls
          // ?status=processing, and CS sees the running time reset.
          started_at: nowIso,
          note: `No response for ${Math.round(STUCK_TRANSFER_MS / 60000)}m — restarted (attempt ${attempts + 1} of ${MAX_TRANSFER_ATTEMPTS}).`,
        })
        .where(eq(gameTransfers.transfer_id, t.transfer_id));
      await txn.insert(transactions).values({
        player_id: locked.player_id,
        type: "game_transfer",
        amount: locked.transfer_amount,
        game_name: `${locked.from_game} → ${locked.to_game}`,
        reference_id: locked.transfer_id,
        details: {
          source: "system",
          action: "restarted",
          attempt: attempts + 1,
        },
      });
      restarted += 1;
    });
  }

  return { restarted, failed };
}

import { eq, inArray, or, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, players } from "@/db/schema";

/**
 * A bot key's casino scope, applied the same way on every /api/bot route.
 *
 * A key with `companyId` set belongs to one casino (a `company` entity, e.g.
 * Pokercity). It must not read or move anything of another casino: players,
 * deposits, withdrawals, game transfers, bank accounts, kiosks. `companyId`
 * null is a full-access key and sees everything, as before.
 *
 * Out-of-scope rows answer 404, not 403, so a scoped key can't probe which ids
 * exist in other casinos.
 */
export type BotScope = { companyId: number | null };

/** True when the key may touch a row belonging to this casino. */
export function inScope(auth: BotScope, companyId: number | null | undefined): boolean {
  return auth.companyId == null || companyId === auth.companyId;
}

/** Limit a casino column to the key's casino; undefined (no filter) for full access. */
export function scopeTo(auth: BotScope, column: AnyColumn): SQL | undefined {
  return auth.companyId == null ? undefined : eq(column, auth.companyId);
}

/** Limit a player_id column to the key's casino's players. */
export function playerScope(auth: BotScope, column: AnyColumn): SQL | undefined {
  if (auth.companyId == null) return undefined;
  return inArray(
    column,
    db
      .select({ id: players.player_id })
      .from(players)
      .where(eq(players.company_entity_id, auth.companyId)),
  );
}

/** Limit a bank account id column to the key's casino's own accounts. */
export function accountScope(auth: BotScope, column: AnyColumn): SQL | undefined {
  if (auth.companyId == null) return undefined;
  return inArray(
    column,
    db
      .select({ id: bankAccounts.account_id })
      .from(bankAccounts)
      .where(eq(bankAccounts.entity_id, auth.companyId)),
  );
}

/** A bank transfer is in scope when either end is one of the casino's accounts. */
export function transferScope(
  auth: BotScope,
  from: AnyColumn,
  to: AnyColumn,
): SQL | undefined {
  if (auth.companyId == null) return undefined;
  return or(accountScope(auth, from), accountScope(auth, to));
}

/** Whether a player (by id) belongs to the key's casino. Missing player → false. */
export async function playerInScope(auth: BotScope, playerId: number | null): Promise<boolean> {
  if (auth.companyId == null) return true;
  if (playerId == null) return false;
  const [p] = await db
    .select({ company: players.company_entity_id })
    .from(players)
    .where(eq(players.player_id, playerId));
  return !!p && p.company === auth.companyId;
}

/** Whether a bank account (by id) belongs to the key's casino. */
export async function accountInScope(auth: BotScope, accountId: number | null): Promise<boolean> {
  if (auth.companyId == null) return true;
  if (accountId == null) return false;
  const [a] = await db
    .select({ entity: bankAccounts.entity_id })
    .from(bankAccounts)
    .where(eq(bankAccounts.account_id, accountId));
  return !!a && a.entity === auth.companyId;
}

/**
 * Hierarchy edits (add / rename / delete leaders, casinos, desks) are an
 * operator's job, not one casino's bot's. A scoped key gets 403.
 */
export function fullAccessOnly(auth: BotScope): Response | null {
  if (auth.companyId == null) return null;
  return Response.json(
    { error: "This key is scoped to one casino; this endpoint needs a full-access key" },
    { status: 403 },
  );
}

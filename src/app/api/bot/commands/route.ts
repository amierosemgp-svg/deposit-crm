import { and, asc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, botCommands, entities } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { bankAccountJson, jsonError } from "@/lib/bot-crud";
import { botCommandJson, expireStaleBotCommands } from "@/lib/bot-commands";

const STATUSES = ["pending", "running", "completed", "failed", "expired"] as const;
const COMMANDS = ["crawl_bank"] as const;

/**
 * GET /api/bot/commands?status=pending&command=crawl_bank&limit=
 *
 * The agent's inbox: work the CRM has asked for on demand, oldest first. Poll
 * it on your normal cycle (~30s is plenty — a command lives for 10 minutes),
 * claim what you take with PATCH /api/bot/commands/:id/status, then report the
 * outcome to the same endpoint.
 *
 * Defaults to `status=pending`, which is what a polling agent wants: anything
 * already claimed is either yours (you know about it) or another process's.
 *
 * Every response expires the stale queue first, so a command handed to you is
 * one that is still worth doing — you will never be given a crawl someone asked
 * for hours ago while you were down.
 *
 * `targets` is included on each row so you don't have to fetch bank accounts
 * separately: it is the resolved list of active deposit accounts to read, with
 * the same login fields /api/bot/bank-accounts returns.
 */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  await expireStaleBotCommands();

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
  const statusParam = url.searchParams.get("status") ?? "pending";
  const commandParam = url.searchParams.get("command");

  const filters: SQL[] = [];

  if (statusParam !== "all") {
    const wanted = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is (typeof STATUSES)[number] =>
        (STATUSES as readonly string[]).includes(s),
      );
    // Don't silently ignore a status we don't know — that returns every command
    // and reads as "the filter worked, there's just nothing there".
    if (!wanted.length) {
      return jsonError(`Invalid status. Use: ${STATUSES.join(", ")}, all`);
    }
    filters.push(inArray(botCommands.status, wanted));
  }

  if (commandParam) {
    if (!(COMMANDS as readonly string[]).includes(commandParam)) {
      return jsonError(`Invalid command. Use: ${COMMANDS.join(", ")}`);
    }
    filters.push(eq(botCommands.command, commandParam as (typeof COMMANDS)[number]));
  }

  // A company-scoped key only sees its own company's commands, plus the
  // unscoped ones — those crawl every bank, this company's included.
  if (auth.companyId != null) {
    filters.push(
      or(
        isNull(botCommands.company_entity_id),
        eq(botCommands.company_entity_id, auth.companyId),
      )!,
    );
  }

  const rows = await db
    .select()
    .from(botCommands)
    // Oldest first: the person who has been waiting longest gets served first.
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(botCommands.command_id))
    .limit(limit);

  const commands = await Promise.all(
    rows.map(async (row) => ({
      ...botCommandJson(row),
      targets: await resolveTargets(row, auth.companyId),
    })),
  );

  return Response.json({ count: commands.length, commands });
}

/**
 * The accounts a crawl_bank command actually covers.
 *
 * A command names either one account or none at all; "none" means every active
 * deposit account inside its scope, which is a question about the entity tree,
 * not something the agent should have to work out. Resolved at read time rather
 * than stored, so an account added or deactivated after the request was queued
 * is handled correctly.
 */
async function resolveTargets(
  row: typeof botCommands.$inferSelect,
  keyCompanyId: number | null,
) {
  const filters: SQL[] = [eq(bankAccounts.status, "active")];

  if (row.bank_account_id != null) {
    filters.push(eq(bankAccounts.account_id, row.bank_account_id));
  } else {
    // A crawl is about money coming in — payout accounts aren't in scope.
    filters.push(eq(bankAccounts.role, "deposit"));
    // Narrowest of the command's own scope and the key's.
    const scopeId = row.company_entity_id ?? keyCompanyId;
    if (scopeId != null) {
      const entityIds = await companySubtree(scopeId);
      filters.push(inArray(bankAccounts.entity_id, entityIds));
    }
  }

  const rows = await db
    .select()
    .from(bankAccounts)
    .where(and(...filters))
    .orderBy(asc(bankAccounts.account_id));

  // Same shape /api/bot/bank-accounts returns, logins included — an agent that
  // can already sign in from that endpoint needs no new field handling here.
  return rows.map(bankAccountJson);
}

/** A company entity plus everything under it — where its accounts can live. */
async function companySubtree(rootId: number): Promise<number[]> {
  const all = await db
    .select({ entity_id: entities.entity_id, parent: entities.parent_entity_id })
    .from(entities);
  const ids = new Set<number>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of all) {
      if (e.parent && ids.has(e.parent) && !ids.has(e.entity_id)) {
        ids.add(e.entity_id);
        grew = true;
      }
    }
  }
  return [...ids];
}

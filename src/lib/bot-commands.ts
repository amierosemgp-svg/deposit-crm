import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { botCommands } from "@/db/schema";

/**
 * How long an on-demand command stays worth doing.
 *
 * A crawl requested at 09:00 must not fire at 14:00 when the agent finally
 * comes back up — by then the scheduled sweep has long since read those
 * transactions and the CS who pressed the button has stopped waiting. Ten
 * minutes is comfortably longer than the agent's ~30s poll and shorter than
 * anyone's patience.
 */
export const BOT_COMMAND_TTL_MS = 10 * 60 * 1000;

/** Statuses a command can still be driven out of — one open command per target. */
export const OPEN_BOT_COMMAND_STATUSES = ["pending", "running"] as const;

export type BotCommandRow = typeof botCommands.$inferSelect;

export function botCommandJson(c: BotCommandRow) {
  return {
    command_id: c.command_id,
    command: c.command,
    status: c.status,
    bank_account_id: c.bank_account_id,
    company_entity_id: c.company_entity_id,
    requested_by_user_id: c.requested_by_user_id,
    bot_id: c.bot_id,
    result: c.result,
    error: c.error,
    expires_at: c.expires_at,
    claimed_at: c.claimed_at,
    completed_at: c.completed_at,
    created_at: c.created_at,
  };
}

/**
 * Settle commands nobody finished.
 *
 * Two ways one goes stale, and they mean different things, so they don't share
 * a status:
 *  - pending past `expires_at` → **expired**. No agent ever picked it up; it
 *    was never anyone's work, and nothing went wrong.
 *  - running for longer than the TTL → **failed**. An agent claimed it and went
 *    quiet. That is a fault worth seeing, and leaving it "running" forever
 *    would also block the next crawl of the same target.
 *
 * Nothing is reversed either way — a command moves no money. Called lazily from
 * the CRM's state poll and from the agent's own poll, so a queue self-heals
 * without needing a cron.
 */
export async function expireStaleBotCommands(): Promise<{
  expired: number;
  failed: number;
}> {
  const nowIso = new Date().toISOString();
  const stallCutoff = new Date(Date.now() - BOT_COMMAND_TTL_MS).toISOString();

  const expired = await db
    .update(botCommands)
    .set({ status: "expired", completed_at: nowIso })
    .where(and(eq(botCommands.status, "pending"), lt(botCommands.expires_at, nowIso)))
    .returning({ command_id: botCommands.command_id });

  const failed = await db
    .update(botCommands)
    .set({
      status: "failed",
      completed_at: nowIso,
      error: "The agent claimed this and never reported back.",
    })
    .where(
      and(
        eq(botCommands.status, "running"),
        // claimed_at is set on every claim; the fallback keeps a row that
        // somehow reached "running" without one from hanging forever.
        or(
          lt(botCommands.claimed_at, stallCutoff),
          and(
            sql`${botCommands.claimed_at} is null`,
            lt(botCommands.created_at, stallCutoff),
          ),
        ),
      ),
    )
    .returning({ command_id: botCommands.command_id });

  return { expired: expired.length, failed: failed.length };
}

/**
 * The open command for a target, if there is one.
 *
 * Pressing "Crawl banks" twice should not queue two crawls — the second would
 * make the agent read the same statement again for nothing. Callers run this
 * inside the advisory-locked transaction in POST /api/bot-commands so two
 * clicks landing together can't both miss it.
 */
export async function findOpenCommand(
  txn: Pick<typeof db, "select">,
  input: {
    command: BotCommandRow["command"];
    bankAccountId: number | null;
    companyEntityId: number | null;
  },
) {
  const [row] = await txn
    .select()
    .from(botCommands)
    .where(
      and(
        eq(botCommands.command, input.command),
        inArray(botCommands.status, [...OPEN_BOT_COMMAND_STATUSES]),
        input.bankAccountId == null
          ? sql`${botCommands.bank_account_id} is null`
          : eq(botCommands.bank_account_id, input.bankAccountId),
        input.companyEntityId == null
          ? sql`${botCommands.company_entity_id} is null`
          : eq(botCommands.company_entity_id, input.companyEntityId),
      ),
    )
    .limit(1);
  return row ?? null;
}

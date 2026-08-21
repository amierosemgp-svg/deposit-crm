import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { botCommands } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { BotError, botErrorResponse, jsonError } from "@/lib/bot-crud";
import { botCommandJson } from "@/lib/bot-commands";

const bodySchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  bot_id: z.string().min(1).max(80).optional(),
  /** Anything worth reporting: accounts_crawled, transactions_found, … */
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(1000).optional(),
});

/**
 * PATCH /api/bot/commands/:id/status — the agent drives an on-demand command:
 *
 *   pending ──claim──▶ running ──▶ completed
 *                          └────▶ failed
 *
 *   - running: claim it. Send `bot_id` so a command that then goes quiet points
 *     at the process to look at. Claiming twice is a no-op rather than an
 *     error, so a retried claim after a network timeout is safe.
 *   - completed: you did the work. Put the counters in `result` — the CRM shows
 *     them next to the button ("2 new deposits"), so an empty crawl and a
 *     productive one look different to the person who asked for it.
 *   - failed: say why in `error`. Nothing is reversed: a command moves no money,
 *     and the scheduled sweep will cover the same ground shortly.
 *
 * Claiming is optional — going straight from pending to completed works. It
 * only costs the "someone is on this" signal the CRM shows while you work.
 *
 * A command that already reached a terminal state is a 409, expired included:
 * an expired crawl is one nobody is waiting for any more, and reporting work
 * against it would put a stale result in front of CS.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const commandId = Number(id);
  if (!Number.isInteger(commandId) || commandId <= 0) {
    return jsonError("Invalid command id");
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Provide status: running | completed | failed");
  }
  const body = parsed.data;

  try {
    const updated = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(botCommands)
        .where(eq(botCommands.command_id, commandId))
        .for("update");
      if (!row) throw new BotError(404, "Command not found");

      // A company-scoped key may only act on its own company's commands, and on
      // the unscoped ones — those cover every company, this one included.
      if (
        auth.companyId != null &&
        row.company_entity_id != null &&
        row.company_entity_id !== auth.companyId
      ) {
        throw new BotError(403, "Command is outside this key's company scope");
      }

      if (row.status !== "pending" && row.status !== "running") {
        throw new BotError(409, `Command already ${row.status} — it can't be changed`);
      }

      const nowIso = new Date().toISOString();

      if (body.status === "running") {
        // Already claimed — a retried claim after a timeout, not an error.
        if (row.status === "running") return row;
        const [claimed] = await txn
          .update(botCommands)
          .set({
            status: "running",
            bot_id: body.bot_id ?? row.bot_id,
            claimed_at: nowIso,
          })
          .where(eq(botCommands.command_id, commandId))
          .returning();
        return claimed;
      }

      const [done] = await txn
        .update(botCommands)
        .set({
          status: body.status,
          bot_id: body.bot_id ?? row.bot_id,
          result: body.result ?? null,
          // Keep the reason on the row itself — it's what CS reads off the page.
          error: body.status === "failed" ? (body.error ?? "No reason given") : null,
          // A command that reached here without a claim still gets a start time,
          // so the UI never shows an end without a beginning.
          claimed_at: row.claimed_at ?? nowIso,
          completed_at: nowIso,
        })
        .where(eq(botCommands.command_id, commandId))
        .returning();
      return done;
    });

    return Response.json({ command: botCommandJson(updated) });
  } catch (e) {
    return botErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

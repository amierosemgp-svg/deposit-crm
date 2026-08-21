import { desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, botCommands, botHealth, entities } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { BOT_ONLINE_MS } from "@/lib/types";
import {
  BOT_COMMAND_TTL_MS,
  botCommandJson,
  expireStaleBotCommands,
  findOpenCommand,
} from "@/lib/bot-commands";

/**
 * GET /api/bot-commands?limit= — recent on-demand commands, for CRM users.
 *
 * The Deposits page reads these off /api/state on its 10s poll; this endpoint
 * is for looking further back than the state payload carries.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    await expireStaleBotCommands();

    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    const rows = await db
      .select()
      .from(botCommands)
      .where(
        user.companyIds === null
          ? undefined
          : // Unscoped commands crawl every bank, this user's included, so they
            // are theirs to see too.
            or(
              isNull(botCommands.company_entity_id),
              inArray(
                botCommands.company_entity_id,
                user.companyIds.length ? user.companyIds : [-1],
              ),
            ),
      )
      .orderBy(desc(botCommands.command_id))
      .limit(limit);

    return Response.json({ count: rows.length, commands: rows.map(botCommandJson) });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

const createSchema = z.object({
  command: z.literal("crawl_bank").default("crawl_bank"),
  /** Null/absent = every active deposit account in scope. */
  bank_account_id: z.number().int().positive().nullish(),
  /** Null/absent = the requester's whole scope. */
  company_entity_id: z.number().int().positive().nullish(),
});

/**
 * POST /api/bot-commands — ask the agent to go and do something now.
 *
 * Today that is one thing: re-read the online-banking transaction list, instead
 * of waiting for the agent's next scheduled sweep. The request is queued, not
 * executed — the agent picks it up on its own poll (~30s) and reports back.
 *
 * Pressing the button twice does not queue two crawls. A second request for the
 * same target returns the open one with `deduped: true`, so the UI shows the
 * crawl already in flight rather than a second one that would read the same
 * statement for nothing. The check runs under an advisory lock because two
 * clicks a few milliseconds apart would otherwise both find nothing open.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const body = parsed.data;

    // Resolve the scope the crawl runs under. A cs_agent or leader can only ask
    // for their own companies; a super admin may ask for one company or for
    // everything (null).
    let companyEntityId = body.company_entity_id ?? null;
    if (user.companyIds !== null) {
      if (companyEntityId === null) {
        if (user.companyIds.length !== 1) {
          // A leader over several companies has to say which one — "crawl
          // everything" is not theirs to ask for.
          throw new AuthError(
            400,
            "Choose a company to crawl — select one in the top bar first",
          );
        }
        companyEntityId = user.companyIds[0];
      } else if (!user.companyIds.includes(companyEntityId)) {
        throw new AuthError(403, "That company is outside your scope");
      }
    }

    if (companyEntityId !== null) {
      const [entity] = await db
        .select()
        .from(entities)
        .where(eq(entities.entity_id, companyEntityId));
      if (!entity) throw new AuthError(404, "Company not found");
    }

    // A named account has to exist, be usable, and sit inside the crawl's scope
    // — otherwise the agent is handed a target it has no business reading.
    const bankAccountId = body.bank_account_id ?? null;
    if (bankAccountId !== null) {
      const [account] = await db
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, bankAccountId));
      if (!account) throw new AuthError(404, "Bank account not found");
      if (account.status !== "active") {
        throw new AuthError(409, "That bank account is inactive");
      }
      if (user.ownedEntityIds !== null && !user.ownedEntityIds.includes(account.entity_id)) {
        throw new AuthError(403, "That bank account is outside your scope");
      }
      if (companyEntityId !== null && account.entity_id !== companyEntityId) {
        throw new AuthError(400, "That bank account belongs to another company");
      }
    }

    await expireStaleBotCommands();

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + BOT_COMMAND_TTL_MS).toISOString();

    const { row, deduped } = await db.transaction(async (txn) => {
      // Serialize requests for this exact target, so two clicks landing together
      // can't both see an empty queue. Transaction-scoped: released on commit.
      await txn.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`bot_command:${body.command}:${bankAccountId ?? 0}:${companyEntityId ?? 0}`}))`,
      );

      const open = await findOpenCommand(txn, {
        command: body.command,
        bankAccountId,
        companyEntityId,
      });
      if (open) return { row: open, deduped: true };

      const [created] = await txn
        .insert(botCommands)
        .values({
          command: body.command,
          bank_account_id: bankAccountId,
          company_entity_id: companyEntityId,
          requested_by_user_id: user.user_id,
          expires_at: expiresIso,
          created_at: nowIso,
        })
        .returning();
      return { row: created, deduped: false };
    });

    // Whether an agent is up right now decides what the UI tells the user: a
    // queued crawl with nothing listening will sit until it expires.
    const bots = await db.select().from(botHealth);
    const agentOnline = bots.some(
      (b) => nowMs - new Date(b.last_heartbeat_at).getTime() < BOT_ONLINE_MS,
    );

    if (!deduped) {
      await logActivity({
        category: "other",
        action: "bot.crawl_requested",
        summary: bankAccountId
          ? `Requested a bank crawl of account #${bankAccountId}`
          : "Requested a bank crawl of all active deposit accounts",
        actor: user,
        companyEntityId,
        targetType: "bot_command",
        targetId: row.command_id,
        context: { command: body.command, agent_online: agentOnline },
      });
    }

    return Response.json(
      { command: botCommandJson(row), deduped, agent_online: agentOnline },
      { status: deduped ? 200 : 201 },
    );
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

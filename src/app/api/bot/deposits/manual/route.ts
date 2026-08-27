import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { deposits } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { depositToBotJson, playerGameInfoMap } from "@/lib/bot-transactions";
import { jsonError } from "@/lib/bot-crud";

const DEPOSIT_STATUSES = [
  "pending_match",
  "matched",
  "pending",
  "approved",
  "processing",
  "completed",
  "failed",
] as const;

/**
 * GET /api/bot/deposits/manual?status=&player_id=&limit=&offset=
 *
 * Every deposit a human had a hand in — **read-only**, and every status by
 * default.
 *
 * This is the counterpart to `/api/bot/transactions`, not a second copy of it.
 * That endpoint is a work queue: it answers "what should I go and do", so it
 * shows only what the agent may act on and defaults to a single status. This
 * one answers "what happened", which is why it filters nothing by default —
 * a completed or failed deposit is exactly what a reconciliation needs to see
 * and precisely what a work queue must leave out.
 *
 * "Manual" covers two independent flags, and a row qualifies on either:
 *   - `source = "manual"`  — typed into the CRM by a person rather than
 *     detected in a bank statement by the agent.
 *   - `skip_bot = true`    — a human drives it end to end. The agent must not
 *     match, top up or complete it.
 * They are genuinely different: CS can enter a deposit by hand and still leave
 * the top-up to the agent (`manual` + `skip_bot = false`), and an
 * agent-detected credit can be flagged for manual handling
 * (`bot` + `skip_bot = true`). Both flags are on every item so the caller can
 * narrow to whichever it meant.
 *
 * Listing a deposit here is not permission to act on it: a `skip_bot` deposit
 * is rejected by the status and match endpoints, which is enforced there rather
 * than left to this endpoint's discretion.
 */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const playerId = url.searchParams.get("player_id");
  const statusParam = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  // Either flag qualifies — see the note above on why they are not the same
  // question.
  const filters: SQL[] = [
    or(eq(deposits.source, "manual"), eq(deposits.skip_bot, true))!,
  ];

  if (playerId) {
    const id = Number(playerId);
    if (!Number.isInteger(id) || id <= 0) {
      return jsonError("Invalid player_id");
    }
    filters.push(eq(deposits.player_id, id));
  }

  // No status filter unless one is asked for: the point of this endpoint is
  // every status. An unrecognised value is a 400 rather than a silently empty
  // list, which would read as "there are none" instead of "you typo'd".
  if (statusParam) {
    const wanted = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const valid = wanted.filter((s): s is (typeof DEPOSIT_STATUSES)[number] =>
      (DEPOSIT_STATUSES as readonly string[]).includes(s),
    );
    if (valid.length !== wanted.length) {
      return jsonError(
        `Invalid status. Use: ${DEPOSIT_STATUSES.join(", ")}`,
      );
    }
    filters.push(inArray(deposits.status, valid));
  }

  const rows = await db
    .select()
    .from(deposits)
    .where(and(...filters))
    .orderBy(desc(deposits.created_at))
    .limit(limit)
    .offset(offset);

  // Same enrichment the work queue gets, so an item read here has the same
  // shape as the same item read there.
  const gameInfo = await playerGameInfoMap(rows.map((r) => r.player_id));
  const items = rows.map((r) =>
    depositToBotJson(r, r.player_id ? gameInfo.get(r.player_id) : null),
  );

  return Response.json({ count: items.length, deposits: items });
}

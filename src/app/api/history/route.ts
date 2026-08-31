import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import { entities, players, transactions, users } from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const AUDIT_TYPES = [
  "deposit",
  "withdrawal",
  "game_topup",
  "game_transfer",
  "credit_pull",
  "bank_transfer",
  "bo_adjustment",
  "player_import",
  "recommend_bonus",
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/history — server-paginated, filtered audit trail. Unlike the store's
 * capped auditLog (500 rows), this pages through the entire transactions table.
 * Query params: limit, offset, type (comma list, or omitted for all),
 * user (all|system|<id>), from, to (YYYY-MM-DD),
 * q (player name/username/reference), player_id, company_id, leader_id (top-nav
 * scope).
 * Rows are always constrained to what the requesting user is allowed to see.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const sp = url.searchParams;

    const limit = Math.min(Math.max(Number(sp.get("limit") ?? 50), 1), 200);
    const offset = Math.max(Number(sp.get("offset") ?? 0), 0);
    const type = sp.get("type");
    const userFilter = sp.get("user");
    const from = sp.get("from");
    const to = sp.get("to");
    const q = sp.get("q")?.trim();
    const playerId = sp.get("player_id");
    const companyId = sp.get("company_id");
    const leaderId = sp.get("leader_id");

    // --- Resolve the effective visible-company scope ---
    // Start from the user's role scope (null = unrestricted), then narrow by the
    // top-nav leader/company filters.
    let allowed: number[] | null = user.companyIds; // null = all companies

    if (leaderId) {
      const leaderCompanies = await db
        .select({ id: entities.entity_id })
        .from(entities)
        .where(
          and(
            eq(entities.parent_entity_id, Number(leaderId)),
            eq(entities.entity_type, "company"),
          ),
        );
      const ids = leaderCompanies.map((c) => c.id);
      allowed = allowed === null ? ids : allowed.filter((c) => ids.includes(c));
    }
    if (companyId) {
      const c = Number(companyId);
      allowed = allowed === null ? [c] : allowed.filter((x) => x === c);
    }

    const conds: SQL[] = [];

    // CS agents work a rolling day — history past 24h is not theirs to browse.
    if (user.role === "cs_agent") {
      conds.push(
        gte(
          transactions.created_at,
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        ),
      );
    }

    // When narrowed to specific companies, only rows for players in those
    // companies are visible (system/null-player events are excluded). A fully
    // unrestricted scope (allowed === null) adds no company constraint.
    if (allowed !== null) {
      conds.push(
        allowed.length
          ? inArray(players.company_entity_id, allowed)
          : sql`false`,
      );
    }

    // Comma-separated, so the UI can tick several types at once. A single
    // value still works unchanged, which keeps older callers and any saved
    // links working.
    if (type && type !== "all") {
      const wanted = type
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const valid = wanted.filter((t): t is (typeof AUDIT_TYPES)[number] =>
        (AUDIT_TYPES as readonly string[]).includes(t),
      );
      // Reject an unknown value rather than quietly dropping it: silently
      // widening the result set reads as "the filter worked", which is worse
      // than an error.
      if (!wanted.length || valid.length !== wanted.length) {
        return jsonError("Invalid type");
      }
      conds.push(inArray(transactions.type, valid));
    }

    // One player's whole trail — what the player profile's Transactions tab
    // reads. Still subject to the company scope above, so it can't be used to
    // reach a player outside the caller's companies.
    if (playerId) {
      const id = Number(playerId);
      if (!Number.isInteger(id) || id <= 0) return jsonError("Invalid player_id");
      conds.push(eq(transactions.player_id, id));
    }

    if (userFilter && userFilter !== "all") {
      if (userFilter === "system") conds.push(isNull(transactions.user_id));
      else conds.push(eq(transactions.user_id, Number(userFilter)));
    }

    if (from && DATE_RE.test(from)) {
      conds.push(sql`${transactions.created_at} >= ${from}::date`);
    }
    if (to && DATE_RE.test(to)) {
      // inclusive of the whole `to` day
      conds.push(sql`${transactions.created_at} < (${to}::date + 1)`);
    }

    if (q) {
      const like = `%${q}%`;
      const search = or(
        ilike(players.full_name, like),
        ilike(players.username, like),
        ilike(sql`${transactions.details}->>'transaction_ref'`, like),
        ilike(sql`${transactions.details}->>'reference'`, like),
        ilike(sql`${transactions.details}->>'topup_reference'`, like),
        ilike(sql`cast(${transactions.reference_id} as text)`, like),
      );
      if (search) conds.push(search);
    }

    const where = conds.length ? and(...conds) : undefined;

    const [rows, [agg]] = await Promise.all([
      db
        .select({
          transaction_id: transactions.transaction_id,
          type: transactions.type,
          player_id: transactions.player_id,
          entity_id: transactions.entity_id,
          amount: transactions.amount,
          game_name: transactions.game_name,
          reference_id: transactions.reference_id,
          details: transactions.details,
          user_id: transactions.user_id,
          created_at: transactions.created_at,
          player_full_name: players.full_name,
          player_username: players.username,
          user_name: users.full_name,
        })
        .from(transactions)
        .leftJoin(players, eq(transactions.player_id, players.player_id))
        .leftJoin(users, eq(transactions.user_id, users.user_id))
        .where(where)
        .orderBy(desc(transactions.created_at))
        .limit(limit)
        .offset(offset),
      db
        .select({
          total: sql<number>`count(*)::int`,
          sum: sql<number>`coalesce(sum(${transactions.amount}), 0)::float8`,
        })
        .from(transactions)
        .leftJoin(players, eq(transactions.player_id, players.player_id))
        .where(where),
    ]);

    return Response.json({
      entries: rows,
      total: agg.total,
      totalAmount: agg.sum,
      limit,
      offset,
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

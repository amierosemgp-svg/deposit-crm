import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { entities, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SOURCES = ["activity", "money", "agent"] as const;
type Source = (typeof SOURCES)[number];

/**
 * GET /api/system-log — every recorded action, newest first.
 *
 * Three tables hold the answer and none of them alone is "the log":
 *   activity_log  — administration: staff, entities, settings, bonuses,
 *                   accounts, keys, sign-ins
 *   transactions  — money: deposits, withdrawals, top-ups, transfers
 *   bot_events    — what the agent did
 *
 * They are unioned at read time rather than mirrored at write time, so every
 * action still has exactly one home and nothing can drift out of sync.
 *
 * Query params: source, category, user (all|system|<id>), from, to
 * (YYYY-MM-DD), q, limit, offset.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    // Deliberately narrower than the rest of the CRM: the log spans companies
    // and includes administration, so CS agents and viewers have no business
    // in it at all.
    if (user.role !== "super_admin" && user.role !== "company_leader") {
      throw new AuthError(403, "Only leaders and admins can read the system log");
    }

    const sp = new URL(request.url).searchParams;
    const limit = Math.min(Math.max(Number(sp.get("limit") ?? 50), 1), 200);
    const offset = Math.max(Number(sp.get("offset") ?? 0), 0);
    const source = sp.get("source");
    const category = sp.get("category");
    const actor = sp.get("user");
    const from = sp.get("from");
    const to = sp.get("to");
    const q = sp.get("q")?.trim();

    if (source && source !== "all" && !SOURCES.includes(source as Source)) {
      return jsonError("Invalid source");
    }

    // --- Scope ---
    // A leader sees their own companies' actions plus anything their own staff
    // did; system-wide rows (settings, API keys, leader accounts) are the super
    // admin's alone.
    const companyIds = user.companyIds; // null = unrestricted
    let staffIds: number[] = [];
    if (companyIds !== null) {
      // Their own subtree only — leader entity, its companies, and the CS desks
      // under those. Not visibleEntityTree(), which also returns the ancestors
      // a hierarchy view needs for context and would hand a leader every action
      // taken by anyone sitting at the main company, the super admin included.
      const desks = companyIds.length
        ? await db
            .select({ id: entities.entity_id })
            .from(entities)
            .where(inArray(entities.parent_entity_id, companyIds))
        : [];
      const ownEntityIds = [
        ...(user.ownedEntityIds ?? [user.entity_id]),
        ...desks.map((d) => d.id),
      ];
      const staff = await db
        .select({ id: users.user_id })
        .from(users)
        .where(inArray(users.entity_id, ownEntityIds.length ? ownEntityIds : [-1]));
      staffIds = staff.map((s) => s.id);
    }

    const idList = (ids: number[]) =>
      sql.join(
        ids.length ? ids.map((id) => sql`${id}`) : [sql`-1`],
        sql`, `,
      );

    const dateConds = (column: SQL | ReturnType<typeof sql.raw>) => {
      const parts: SQL[] = [];
      if (from && DATE_RE.test(from)) parts.push(sql`${column} >= ${from}::date`);
      if (to && DATE_RE.test(to)) parts.push(sql`${column} < (${to}::date + 1)`);
      return parts;
    };

    const like = q ? `%${q}%` : null;
    // Fetch only as deep as this page reaches: the global newest N is always
    // inside each branch's own newest N, so a per-branch cap is safe and keeps
    // the union from materialising three whole tables.
    const branchCap = limit + offset;

    const wants = (s: Source) => !source || source === "all" || source === s;

    const branches: SQL[] = [];
    const counts: SQL[] = [];

    // ---------- Administration ----------
    if (wants("activity")) {
      const conds: SQL[] = [...dateConds(sql`a.occurred_at`)];
      if (companyIds !== null) {
        conds.push(
          sql`(a.company_entity_id in (${idList(companyIds)}) or a.actor_user_id in (${idList(staffIds)}))`,
        );
      }
      if (category && category !== "all") {
        conds.push(sql`a.category::text = ${category}`);
      }
      if (actor === "system") conds.push(sql`a.actor_user_id is null`);
      else if (actor && actor !== "all") conds.push(sql`a.actor_user_id = ${Number(actor)}`);
      if (like) {
        conds.push(
          sql`(a.summary ilike ${like} or a.action ilike ${like} or a.target_label ilike ${like} or a.actor_label ilike ${like})`,
        );
      }
      const where = conds.length
        ? sql`where ${sql.join(conds, sql` and `)}`
        : sql``;

      branches.push(sql`(
        select 'activity'::text as source,
               a.log_id as id,
               a.occurred_at as occurred_at,
               a.category::text as category,
               a.action as action,
               a.summary as summary,
               a.actor_user_id as actor_user_id,
               coalesce(u.full_name, a.actor_label)::text as actor_label,
               a.company_entity_id as company_entity_id,
               a.target_label::text as target_label,
               null::numeric as amount,
               jsonb_strip_nulls(jsonb_build_object(
                 'changes', a.changes,
                 'context', a.context,
                 'target_type', a.target_type,
                 'target_id', a.target_id
               )) as details
        from activity_log a
        left join users u on u.user_id = a.actor_user_id
        ${where}
        order by a.occurred_at desc
        limit ${branchCap}
      )`);
      counts.push(sql`(select count(*) from activity_log a ${where})`);
    }

    // ---------- Money ----------
    if (wants("money")) {
      const conds: SQL[] = [...dateConds(sql`t.created_at`)];
      if (companyIds !== null) {
        // Rows with no player (system/bank-level) carry no company, so a
        // scoped reader can't be shown them.
        conds.push(sql`p.company_entity_id in (${idList(companyIds)})`);
      }
      if (category && category !== "all") {
        conds.push(sql`t.type::text = ${category}`);
      }
      if (actor === "system") conds.push(sql`t.user_id is null`);
      else if (actor && actor !== "all") conds.push(sql`t.user_id = ${Number(actor)}`);
      if (like) {
        conds.push(
          sql`(p.username ilike ${like} or p.full_name ilike ${like} or t.details->>'action' ilike ${like} or t.details->>'transaction_ref' ilike ${like} or cast(t.reference_id as text) ilike ${like})`,
        );
      }
      const where = conds.length
        ? sql`where ${sql.join(conds, sql` and `)}`
        : sql``;

      branches.push(sql`(
        select 'money'::text as source,
               t.transaction_id as id,
               t.created_at as occurred_at,
               t.type::text as category,
               coalesce(t.details->>'action', t.type::text)::text as action,
               null::text as summary,
               t.user_id as actor_user_id,
               tu.full_name::text as actor_label,
               p.company_entity_id as company_entity_id,
               p.username::text as target_label,
               t.amount as amount,
               t.details as details
        from transactions t
        left join players p on p.player_id = t.player_id
        left join users tu on tu.user_id = t.user_id
        ${where}
        order by t.created_at desc
        limit ${branchCap}
      )`);
      counts.push(sql`(select count(*) from transactions t left join players p on p.player_id = t.player_id ${where})`);
    }

    // ---------- Agent ----------
    // Not company-scoped: the agent is shared infrastructure, and its feed is
    // already on the Agent Health page for every role.
    if (wants("agent")) {
      const conds: SQL[] = [...dateConds(sql`e.occurred_at`)];
      if (category && category !== "all") {
        conds.push(sql`e.level::text = ${category}`);
      }
      // Agent rows have no user behind them; asking for one person's actions
      // must not sweep the whole feed in.
      if (actor && actor !== "all" && actor !== "system") conds.push(sql`false`);
      if (like) {
        conds.push(
          sql`(e.event ilike ${like} or e.message ilike ${like} or e.bot_id ilike ${like})`,
        );
      }
      const where = conds.length
        ? sql`where ${sql.join(conds, sql` and `)}`
        : sql``;

      branches.push(sql`(
        select 'agent'::text as source,
               e.event_id as id,
               e.occurred_at as occurred_at,
               e.level::text as category,
               e.event as action,
               e.message as summary,
               null::integer as actor_user_id,
               e.bot_id::text as actor_label,
               null::integer as company_entity_id,
               null::text as target_label,
               null::numeric as amount,
               e.context as details
        from bot_events e
        ${where}
        order by e.occurred_at desc
        limit ${branchCap}
      )`);
      counts.push(sql`(select count(*) from bot_events e ${where})`);
    }

    if (!branches.length) {
      return Response.json({ entries: [], total: 0, limit, offset });
    }

    // Each branch is parenthesised: in a UNION an unbracketed ORDER BY/LIMIT
    // binds to the whole statement, not the branch it was written under.
    const unioned = sql.join(branches, sql` union all `);
    const [rows, countResult] = await Promise.all([
      db.execute(sql`
        select * from (${unioned}) as log
        order by occurred_at desc
        limit ${limit} offset ${offset}
      `),
      db.execute(sql`select ${sql.join(counts, sql` + `)} as total`),
    ]);

    // Company names for the scope column — a few ids, resolved once.
    const companyRows = await db
      .select({ id: entities.entity_id, name: entities.name })
      .from(entities)
      .where(eq(entities.entity_type, "company"));
    const companyName = new Map(companyRows.map((c) => [c.id, c.name]));

    const entries = (rows.rows as Record<string, unknown>[]).map((r) => ({
      source: r.source as Source,
      id: Number(r.id),
      occurred_at: r.occurred_at,
      category: r.category as string,
      action: r.action as string,
      summary: r.summary as string | null,
      actor_user_id: r.actor_user_id === null ? null : Number(r.actor_user_id),
      actor_label: r.actor_label as string | null,
      company_entity_id:
        r.company_entity_id === null ? null : Number(r.company_entity_id),
      company_name:
        r.company_entity_id === null
          ? null
          : (companyName.get(Number(r.company_entity_id)) ?? null),
      target_label: r.target_label as string | null,
      amount: r.amount === null ? null : Number(r.amount),
      details: r.details as Record<string, unknown> | null,
    }));

    return Response.json({
      entries,
      total: Number((countResult.rows[0] as { total: string | number })?.total ?? 0),
      limit,
      offset,
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

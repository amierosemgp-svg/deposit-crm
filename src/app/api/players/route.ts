import { z } from "zod";
import { db } from "@/db";
import {
  entities,
  leadLists,
  listDistributions,
  listLeads,
  people,
  players,
  transactions,
} from "@/db/schema";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { findOrCreatePerson } from "@/lib/people";
import { formatCode } from "@/lib/lead-lists";
import { AuthError, authErrorResponse, requireUser, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { loadGameCatalogue, normaliseGameAccounts } from "@/lib/game-name";

const playerSchema = z.object({
  username: z.string().min(2),
  full_name: z.string().min(1),
  contact_number: z.string().optional(),
  telegram_username: z.string().min(2).optional(),
  wechat_id: z.string().optional(),
  company_entity_id: z.number().int().positive(),
  // Convert from a lead-list distribution: the member code auto-populates from
  // the distribution's counter and the member is linked to the list.
  source_dist_id: z.number().int().positive().optional(),
  bank_accounts: z
    .array(
      z.object({
        bank_name: z.string(),
        account_number: z.string(),
        account_holder: z.string(),
      }),
    )
    .optional(),
  game_accounts: z
    .array(z.object({ game_name: z.string(), game_username: z.string() }))
    .optional(),
  notes: z.string().optional(),
});

const createSchema = z.union([playerSchema, z.array(playerSchema).min(1)]);

/** Rows per INSERT — keeps each statement well under Postgres's parameter cap. */
const INSERT_CHUNK = 500;

/**
 * GET /api/players — the roster, a page at a time.
 *
 * The client used to hold every member, shipped whole inside /api/state. That
 * was tenable at a few hundred; Pokercity's master list took it to 12,280,
 * which is 8 MB of JSON re-sent on every poll that follows a member edit —
 * and completing a deposit edits a member, so that is most polls during a
 * shift. Nothing on screen ever needed the whole roster: a sheet needs the
 * members on the rows it is showing, and a search box needs the handful that
 * match what was typed. Both are questions for the database.
 *
 * Query:
 *   ids      comma-separated player ids — hydrate exactly these, no paging
 *   q        free text over member code, name, phone and game logins
 *   company  restrict to one company (must be in scope)
 *   prefix   member-code series, e.g. GA
 *   upline   members introduced by this player
 *   last_dep "never", "within:30", "over:90" — how long since they last paid in
 *   limit    default 100, max 500
 *   offset   where to start
 *
 * Every row carries `last_deposit_at`, so the roster needs no second request to
 * say who has gone cold.
 *
 * Returns { players, total, limit, offset } so a caller can page without
 * guessing whether more exist.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sp = new URL(request.url).searchParams;

    const scope: SQL[] = [];
    if (user.companyIds !== null) {
      scope.push(
        user.companyIds.length
          ? sql`p.company_entity_id IN (${sql.join(
              user.companyIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql`false`,
      );
    }

    const companyParam = sp.get("company");
    if (companyParam && companyParam !== "all") {
      const companyId = Number(companyParam);
      if (!Number.isFinite(companyId)) return jsonError("Bad company");
      scope.push(sql`p.company_entity_id = ${companyId}`);
    }

    // Hydrate-by-id: the sheets ask for the members on the rows they drew.
    const idsParam = sp.get("ids");
    if (idsParam !== null) {
      const ids = idsParam
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) return Response.json({ players: [], total: 0, limit: 0, offset: 0 });
      if (ids.length > MAX_HYDRATE) {
        return jsonError(`Too many ids — ${MAX_HYDRATE} at a time`);
      }
      scope.push(sql`p.player_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      const rows = await db.execute(sql`
        SELECT to_jsonb(p) || jsonb_build_object(
                 'last_deposit_at',
                 (SELECT max(d.deposit_date) FROM deposits d
                   WHERE d.player_id = p.player_id AND d.status <> 'failed')) AS row
          FROM players p
         WHERE ${sql.join(scope, sql` AND `)}`);
      const list = rows.rows.map((r) => (r as { row: unknown }).row);
      return Response.json({ players: list, total: list.length, limit: list.length, offset: 0 });
    }

    /**
     * Search covers what CS actually types: the member code, the name, the
     * phone, and the game login — a player is often identified by the login
     * written on a deposit slip rather than by their code.
     */
    const q = (sp.get("q") ?? "").trim().toLowerCase();
    if (q) {
      const like = `%${q}%`;
      scope.push(sql`(
        lower(p.username) LIKE ${like}
        OR lower(p.full_name) LIKE ${like}
        OR lower(coalesce(p.contact_number, '')) LIKE ${like}
        OR lower(coalesce(p.telegram_username, '')) LIKE ${like}
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(coalesce(p.game_accounts, '[]'::jsonb)) g
           WHERE lower(g->>'game_username') LIKE ${like})
      )`);
    }

    // Everyone this member introduced — the Referrals tab's own list.
    const upline = sp.get("upline");
    if (upline !== null) {
      const uplineId = Number(upline);
      if (!Number.isInteger(uplineId) || uplineId <= 0) return jsonError("Bad upline");
      scope.push(sql`p.upline_player_id = ${uplineId}`);
    }

    const prefix = (sp.get("prefix") ?? "").trim();
    if (prefix && prefix !== "all") {
      if (!/^[A-Za-z]{1,4}$/.test(prefix)) return jsonError("Bad prefix");
      // Anchored on the letters, so GA does not also match G.
      scope.push(sql`upper((regexp_match(p.username, '^([A-Za-z]+)'))[1]) = ${prefix.toUpperCase()}`);
    }

    /**
     * How long since the member last paid in. "Never deposited" is a different
     * answer from "a long time ago", so it is its own option rather than being
     * swept into "over N days".
     */
    const lastDep = (sp.get("last_dep") ?? "").trim();
    if (lastDep) {
      const lastAt = sql`(SELECT max(d.deposit_date) FROM deposits d
                           WHERE d.player_id = p.player_id AND d.status <> 'failed')`;
      if (lastDep === "never") {
        scope.push(sql`${lastAt} IS NULL`);
      } else {
        const [dir, raw] = lastDep.split(":");
        const days = Number(raw);
        if ((dir !== "within" && dir !== "over") || !Number.isFinite(days)) {
          return jsonError("Bad last_dep");
        }
        scope.push(
          dir === "within"
            ? sql`${lastAt} >= now() - make_interval(days => ${Math.floor(days)})`
            : sql`${lastAt} < now() - make_interval(days => ${Math.floor(days)})`,
        );
      }
    }

    const limit = Math.min(Math.max(Number(sp.get("limit") ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(sp.get("offset") ?? 0) || 0, 0);
    const where = scope.length ? sql.join(scope, sql` AND `) : sql`true`;

    const rows = await db.execute(sql`
      SELECT to_jsonb(p) || jsonb_build_object(
               'last_deposit_at',
               (SELECT max(d.deposit_date) FROM deposits d
                 WHERE d.player_id = p.player_id AND d.status <> 'failed')) AS row
        FROM players p
       WHERE ${where}
       -- Newest first, player_id breaking ties: a bulk import gives every row
       -- the same registration_date, and without the tiebreak the same member
       -- can appear on two pages and another on none.
       ORDER BY p.registration_date DESC, p.player_id DESC
       LIMIT ${limit} OFFSET ${offset}`);

    const [totals] = (await db.execute(sql`
      SELECT count(*)::int AS total FROM players p WHERE ${where}`)).rows as unknown as {
      total: number;
    }[];

    return Response.json({
      players: rows.rows.map((r) => (r as { row: unknown }).row),
      total: totals?.total ?? 0,
      limit,
      offset,
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/** Most ids one hydrate call may ask for — a sheet page is far smaller. */
const MAX_HYDRATE = 500;

/** POST /api/players — create one player, or an array (import). */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    }
    // Lead-list-linked create: one member, code auto-numbered from the list.
    if (!Array.isArray(parsed.data) && parsed.data.source_dist_id) {
      return await createFromDistribution(user, parsed.data);
    }

    const rows = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

    // Validate the companies once over the distinct ids. This used to be a
    // SELECT per row, awaited in sequence — an import assigns the same company
    // to every row, so a 2,600-row file meant 2,600 identical round trips and
    // the request died on the function timeout before reaching the insert.
    const companyIds = [...new Set(rows.map((r) => r.company_entity_id))];
    for (const id of companyIds) {
      if (user.companyIds !== null && !user.companyIds.includes(id)) {
        throw new AuthError(403, `Company ${id} is outside your scope`);
      }
    }
    const found = await db
      .select({ id: entities.entity_id, type: entities.entity_type })
      .from(entities)
      .where(inArray(entities.entity_id, companyIds));
    const companies = new Set(
      found.filter((e) => e.type === "company").map((e) => e.id),
    );
    const notCompany = companyIds.find((id) => !companies.has(id));
    if (notCompany !== undefined) {
      return jsonError(`Entity ${notCompany} is not a company`);
    }

    // One account per game, in the catalogue's spelling. Done before the
    // insert so an import that carries a duplicate is rejected whole rather
    // than half-landing a player whose accounts are ambiguous.
    const catalogue = await loadGameCatalogue();
    const values = rows.map((r) => ({
      ...r,
      ...(r.game_accounts
        ? { game_accounts: normaliseGameAccounts(r.game_accounts, catalogue) }
        : {}),
      telegram_username: !r.telegram_username
        ? null
        : r.telegram_username.startsWith("@")
          ? r.telegram_username
          : `@${r.telegram_username}`,
    }));

    // One statement per chunk rather than one giant multi-row INSERT: Postgres
    // caps a statement at 65,535 bind parameters, and a wide table reaches that
    // sooner than the row count suggests. All in one transaction, so a big
    // import can't half-land.
    const created = await db.transaction(async (txn) => {
      // Resolve each row to a global person by phone (one phone = one person),
      // creating the missing ones. Batched so a 2,600-row import stays a handful
      // of queries, not one per row.
      const phones = [
        ...new Set(
          values
            .map((v) => v.contact_number?.trim())
            .filter((x): x is string => !!x)
            .map((x) => x.toLowerCase()),
        ),
      ];
      const existingPeople = phones.length
        ? await txn
            .select({ id: people.person_id, phone: sql<string>`lower(${people.contact_number})` })
            .from(people)
            .where(inArray(sql`lower(${people.contact_number})`, phones))
        : [];
      const personByPhone = new Map(existingPeople.map((r) => [r.phone, r.id]));
      // Create people for phones not seen yet.
      const newPhones = phones.filter((ph) => !personByPhone.has(ph));
      for (const ph of newPhones) {
        const row = values.find((v) => v.contact_number?.trim().toLowerCase() === ph)!;
        const [created] = await txn
          .insert(people)
          .values({ contact_number: row.contact_number!.trim(), full_name: row.full_name })
          .returning({ id: people.person_id });
        personByPhone.set(ph, created.id);
      }
      // Rows with no phone each get their own review person.
      const withPerson = [];
      for (const v of values) {
        const ph = v.contact_number?.trim().toLowerCase();
        let personId = ph ? personByPhone.get(ph) : undefined;
        if (!personId) {
          const [pp] = await txn
            .insert(people)
            .values({ contact_number: null, full_name: v.full_name, needs_review: true })
            .returning({ id: people.person_id });
          personId = pp.id;
        }
        withPerson.push({ ...v, person_id: personId });
      }

      const inserted: (typeof players.$inferSelect)[] = [];
      for (let i = 0; i < withPerson.length; i += INSERT_CHUNK) {
        const batch = await txn
          .insert(players)
          .values(withPerson.slice(i, i + INSERT_CHUNK))
          .returning();
        inserted.push(...batch);
      }
      for (let i = 0; i < inserted.length; i += INSERT_CHUNK) {
        await txn.insert(transactions).values(
          inserted.slice(i, i + INSERT_CHUNK).map((p) => ({
            player_id: p.player_id,
            entity_id: p.company_entity_id,
            type: "player_import" as const,
            amount: 0,
            user_id: user.user_id,
            details: {
              username: p.username,
              company_entity_id: p.company_entity_id,
            },
          })),
        );
      }
      return inserted;
    });

    return Response.json({ players: created }, { status: 201 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    const msg = e instanceof Error && e.message.includes("duplicate")
      ? "A player with that username already exists"
      : "Server error";
    console.error(e);
    return jsonError(msg, msg === "Server error" ? 500 : 409);
  }
}


type PlayerInput = z.infer<typeof playerSchema>;

/**
 * Create a member by converting a lead from a distributed list. The member code
 * is taken from the distribution's counter (prefix + next_seq) — this is the
 * "auto-populated incremental" the workflow needs — and the person is linked as
 * a lead if not already, so every list_B member traces back to list_A.
 */
async function createFromDistribution(
  user: Awaited<ReturnType<typeof requireWriteUser>>,
  body: PlayerInput,
): Promise<Response> {
  const distId = body.source_dist_id!;
  const catalogue = await loadGameCatalogue();
  const created = await db.transaction(async (txn) => {
    const [dist] = await txn
      .select()
      .from(listDistributions)
      .where(eq(listDistributions.dist_id, distId))
      .for("update");
    if (!dist) throw new AuthError(404, "Lead list distribution not found");
    if (dist.to_entity_id !== body.company_entity_id) {
      throw new AuthError(422, "That list is distributed to a different company");
    }
    if (user.companyIds !== null && !user.companyIds.includes(body.company_entity_id)) {
      throw new AuthError(403, "Company is outside your scope");
    }
    const [list] = await txn
      .select()
      .from(leadLists)
      .where(eq(leadLists.list_id, dist.list_id))
      .for("update");
    if (!list) throw new AuthError(404, "Lead list not found");

    // Resolve the person by phone; add as a lead if not one yet (keeps the
    // list complete so conversion stays traceable).
    const { person } = await findOrCreatePerson(txn, {
      contact_number: body.contact_number,
      full_name: body.full_name,
      telegram_username: body.telegram_username,
      wechat_id: body.wechat_id,
    });
    const [existingLead] = await txn
      .select()
      .from(listLeads)
      .where(and(eq(listLeads.list_id, list.list_id), eq(listLeads.person_id, person.person_id)));
    if (!existingLead) {
      await txn.insert(listLeads).values({
        list_id: list.list_id,
        person_id: person.person_id,
        lead_code: formatCode(list.prefix, list.next_seq),
        seq: list.next_seq,
      });
      await txn.update(leadLists).set({ next_seq: list.next_seq + 1 }).where(eq(leadLists.list_id, list.list_id));
    }

    // Already a member at this company? Return it (idempotent).
    const [dupe] = await txn
      .select()
      .from(players)
      .where(
        and(
          eq(players.company_entity_id, body.company_entity_id),
          eq(players.person_id, person.person_id),
        ),
      );
    if (dupe) return dupe;

    const seq = dist.next_seq;
    const code = formatCode(dist.prefix, seq);
    const nowIso = new Date().toISOString();
    const [member] = await txn
      .insert(players)
      .values({
        username: code,
        full_name: body.full_name,
        contact_number: body.contact_number,
        telegram_username: body.telegram_username
          ? body.telegram_username.startsWith("@")
            ? body.telegram_username
            : `@${body.telegram_username}`
          : null,
        wechat_id: body.wechat_id,
        company_entity_id: body.company_entity_id,
        person_id: person.person_id,
        source_dist_id: dist.dist_id,
        notes: body.notes,
        registration_date: nowIso,
        bank_accounts: body.bank_accounts,
        game_accounts: body.game_accounts
          ? normaliseGameAccounts(body.game_accounts, catalogue)
          : body.game_accounts,
      })
      .returning();
    await txn.update(listDistributions).set({ next_seq: seq + 1 }).where(eq(listDistributions.dist_id, dist.dist_id));
    return member;
  });

  return Response.json({ players: [created] }, { status: 201 });
}

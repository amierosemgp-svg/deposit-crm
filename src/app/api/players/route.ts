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
import { and, eq, inArray, sql } from "drizzle-orm";
import { findOrCreatePerson } from "@/lib/people";
import { formatCode } from "@/lib/lead-lists";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
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

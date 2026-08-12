import { z } from "zod";
import { db } from "@/db";
import { entities, players, transactions } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const playerSchema = z.object({
  username: z.string().min(2),
  full_name: z.string().min(1),
  contact_number: z.string().optional(),
  telegram_username: z.string().min(2).optional(),
  wechat_id: z.string().optional(),
  company_entity_id: z.number().int().positive(),
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

    const values = rows.map((r) => ({
      ...r,
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
      const inserted: (typeof players.$inferSelect)[] = [];
      for (let i = 0; i < values.length; i += INSERT_CHUNK) {
        const batch = await txn
          .insert(players)
          .values(values.slice(i, i + INSERT_CHUNK))
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

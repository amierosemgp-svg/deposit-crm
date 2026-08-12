import { z } from "zod";
import { db } from "@/db";
import { entities, players, transactions } from "@/db/schema";
import { eq } from "drizzle-orm";
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

/** POST /api/players — create one player, or an array (import). */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    }
    const rows = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

    for (const row of rows) {
      if (
        user.companyIds !== null &&
        !user.companyIds.includes(row.company_entity_id)
      ) {
        throw new AuthError(
          403,
          `Company ${row.company_entity_id} is outside your scope`,
        );
      }
      const [company] = await db
        .select()
        .from(entities)
        .where(eq(entities.entity_id, row.company_entity_id));
      if (!company || company.entity_type !== "company") {
        return jsonError(`Entity ${row.company_entity_id} is not a company`);
      }
    }

    const created = await db
      .insert(players)
      .values(
        rows.map((r) => ({
          ...r,
          telegram_username: !r.telegram_username
            ? null
            : r.telegram_username.startsWith("@")
            ? r.telegram_username
            : `@${r.telegram_username}`,
        })),
      )
      .returning();

    await db.insert(transactions).values(
      created.map((p) => ({
        player_id: p.player_id,
        entity_id: p.company_entity_id,
        type: "player_import" as const,
        amount: 0,
        user_id: user.user_id,
        details: { username: p.username, company_entity_id: p.company_entity_id },
      })),
    );

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

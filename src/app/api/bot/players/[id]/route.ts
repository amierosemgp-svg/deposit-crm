import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { loadGameCatalogue, normaliseGameAccounts } from "@/lib/game-name";
import { botErrorResponse, isFkViolation, jsonError, playerJson } from "@/lib/bot-crud";
import { recordGameAccountChanges } from "@/lib/game-account-audit";

/** Resolve a player by numeric id or username. */
async function findPlayer(id: string) {
  const numeric = Number(id);
  const [row] =
    Number.isInteger(numeric) && numeric > 0
      ? await db.select().from(players).where(eq(players.player_id, numeric))
      : await db.select().from(players).where(eq(players.username, id.toLowerCase()));
  return row;
}

/** GET /api/bot/players/:id  (:id = player_id or username) */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const row = await findPlayer(id);
  if (!row) return jsonError("Player not found", 404);
  return Response.json({ player: playerJson(row) });
}

const patchSchema = z.object({
  full_name: z.string().min(1).optional(),
  telegram_username: z.string().min(2).optional(),
  contact_number: z.string().nullable().optional(),
  wechat_id: z.string().nullable().optional(),
  company_entity_id: z.number().int().positive().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  notes: z.string().nullable().optional(),
  bank_accounts: z
    .array(z.object({ bank_name: z.string(), account_number: z.string(), account_holder: z.string() }))
    .optional(),
  game_accounts: z
    .array(z.object({ game_name: z.string(), game_username: z.string() }))
    .optional(),
});

/** PATCH /api/bot/players/:id */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const row = await findPlayer(id);
  if (!row) return jsonError("Player not found", 404);

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
  }
  const patch = { ...parsed.data };
  if (patch.telegram_username && !patch.telegram_username.startsWith("@")) {
    patch.telegram_username = `@${patch.telegram_username}`;
  }
  if (patch.game_accounts !== undefined) {
    try {
      patch.game_accounts = normaliseGameAccounts(
        patch.game_accounts,
        await loadGameCatalogue(),
      );
    } catch (e) {
      // This handler has no outer catch, so the 409 is raised here rather than
      // escaping as an unhandled rejection and surfacing as a 500.
      const domain = botErrorResponse(e);
      if (domain) return domain;
      throw e;
    }
  }

  const [updated] = await db
    .update(players)
    .set(patch)
    .where(eq(players.player_id, row.player_id))
    .returning();

  if (patch.game_accounts !== undefined) {
    await recordGameAccountChanges(
      row.player_id,
      row.game_accounts,
      updated.game_accounts,
      { source: "bot" },
    );
  }

  return Response.json({ player: playerJson(updated) });
}

/**
 * DELETE /api/bot/players/:id
 * Hard-deletes when the player has no financial history; otherwise returns 409
 * (suspend via PATCH status=suspended instead, to preserve the audit trail).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const row = await findPlayer(id);
  if (!row) return jsonError("Player not found", 404);

  try {
    await db.delete(players).where(eq(players.player_id, row.player_id));
    return Response.json({ ok: true, deleted: row.player_id });
  } catch (e) {
    if (isFkViolation(e)) {
      return jsonError(
        "Player has transaction history and cannot be deleted. Suspend instead: PATCH status=suspended.",
        409,
      );
    }
    console.error(e);
    return jsonError("Server error", 500);
  }
}

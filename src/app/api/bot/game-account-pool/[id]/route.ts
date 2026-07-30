import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameAccountPool } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { jsonError } from "@/lib/bot-crud";

const patchSchema = z.object({
  status: z.enum(["available", "retired"]),
  note: z.string().max(500).optional(),
});

/**
 * PATCH /api/bot/game-account-pool/:id — retire an account the provider has
 * closed or banned, or put a retired one back into circulation.
 *
 * An assigned account can't be retired here: a player is using it, and the
 * account has to be unlinked from them first. Retiring underneath them would
 * leave the CRM pointing at a dead game id.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const poolId = Number(id);
  if (!Number.isInteger(poolId) || poolId <= 0) {
    return jsonError("Invalid pool id");
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Provide status: available | retired (optional note)");
  }

  const [row] = await db
    .select()
    .from(gameAccountPool)
    .where(eq(gameAccountPool.pool_id, poolId));
  if (!row) return jsonError("Pool account not found", 404);

  if (row.status === "assigned") {
    return jsonError(
      `Account is assigned to player ${row.assigned_player_id} — unlink it from the player first`,
      409,
    );
  }

  const [updated] = await db
    .update(gameAccountPool)
    .set({ status: parsed.data.status, note: parsed.data.note ?? row.note })
    .where(eq(gameAccountPool.pool_id, poolId))
    .returning();

  return Response.json({ account: updated });
}

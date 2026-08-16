import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { describeChanges, diffFields, logActivity } from "@/lib/activity-log";
import { recordGameAccountChanges } from "@/lib/game-account-audit";

const patchSchema = z.object({
  full_name: z.string().min(1).optional(),
  contact_number: z.string().nullable().optional(),
  telegram_username: z.string().min(2).optional(),
  wechat_id: z.string().nullable().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  notes: z.string().nullable().optional(),
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
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const playerId = Number(id);

    const [row] = await db
      .select()
      .from(players)
      .where(eq(players.player_id, playerId));
    if (!row) return jsonError("Player not found", 404);
    if (
      user.companyIds !== null &&
      !user.companyIds.includes(row.company_entity_id)
    ) {
      throw new AuthError(403, "Player is outside your company scope");
    }

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");

    const [updated] = await db
      .update(players)
      .set(parsed.data)
      .where(eq(players.player_id, playerId))
      .returning();

    // Only when the caller actually sent game_accounts — an unrelated patch
    // must not look like every account was removed.
    if (parsed.data.game_accounts !== undefined) {
      await recordGameAccountChanges(
        playerId,
        row.game_accounts,
        updated.game_accounts,
        { userId: user.user_id, source: "manual" },
      );
    }

    // Player creation is already in the ledger as player_import; only edits
    // need recording here, and each action belongs to exactly one source.
    const changes = diffFields(row, parsed.data);
    if (changes.length) {
      await logActivity({
        category: "player",
        action:
          parsed.data.status && parsed.data.status !== row.status
            ? `player.${parsed.data.status === "suspended" ? "suspended" : "reactivated"}`
            : "player.updated",
        summary: `Player "${row.username}" (${row.full_name}) — ${describeChanges(changes)}`,
        actor: user,
        companyEntityId: row.company_entity_id,
        targetType: "player",
        targetId: row.player_id,
        targetLabel: row.username,
        changes,
      });
    }

    return Response.json({ player: updated });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

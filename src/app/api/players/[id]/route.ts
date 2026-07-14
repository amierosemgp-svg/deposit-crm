import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

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

    return Response.json({ player: updated });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

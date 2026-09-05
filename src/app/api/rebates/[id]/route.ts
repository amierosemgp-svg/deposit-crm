import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players, rebatePayouts } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const schema = z
  .object({
    // Skip a row (it stays on the list, greyed) or put it back.
    status: z.enum(["pending", "skipped"]).optional(),
    // Change where the credit will go before paying.
    game_name: z.string().min(1).max(60).nullable().optional(),
    game_username: z.string().max(120).nullable().optional(),
    note: z.string().max(200).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change" });

/** PATCH /api/rebates/:id — edit an unpaid rebate row. A paid row is history. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireWriteUser();
    const id = Number((await ctx.params).id);
    if (!Number.isInteger(id) || id <= 0) return jsonError("Bad payout id");
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");

    const [row] = await db
      .select({ payout: rebatePayouts, company: players.company_entity_id, username: players.username })
      .from(rebatePayouts)
      .innerJoin(players, eq(players.player_id, rebatePayouts.player_id))
      .where(eq(rebatePayouts.payout_id, id));
    if (!row) throw new AuthError(404, "Payout not found");
    if (user.companyIds !== null && !user.companyIds.includes(row.company)) {
      throw new AuthError(403, "Player is outside your company scope");
    }
    if (row.payout.status === "paid") {
      return jsonError("This rebate is already paid and can't be changed", 409);
    }

    const patch = parsed.data;
    const [updated] = await db
      .update(rebatePayouts)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.game_name !== undefined ? { game_name: patch.game_name } : {}),
        ...(patch.game_username !== undefined ? { game_username: patch.game_username } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
      })
      .where(eq(rebatePayouts.payout_id, id))
      .returning();

    return Response.json({ payout: updated });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deposits } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { depositToBotJson, playerGameInfoMap } from "@/lib/bot-transactions";

/**
 * GET /api/bot/transactions/:id
 * Agent use-case #3: fetch one transaction for validation.
 * :id accepts either the numeric CRM id or the agent's external_id.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const numeric = Number(id);
  const [row] = Number.isInteger(numeric) && numeric > 0
    ? await db.select().from(deposits).where(eq(deposits.deposit_id, numeric))
    : await db.select().from(deposits).where(eq(deposits.external_id, id));

  if (!row) {
    return Response.json({ error: "Transaction not found" }, { status: 404 });
  }
  const gameInfo = await playerGameInfoMap([row.player_id]);
  return Response.json({
    transaction: depositToBotJson(
      row,
      row.player_id ? gameInfo.get(row.player_id) : null,
    ),
  });
}

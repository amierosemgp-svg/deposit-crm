import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankTransfers } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { bankTransferJson, jsonError } from "@/lib/bot-crud";

/** GET /api/bot/transfers/:id */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const [row] = await db
    .select()
    .from(bankTransfers)
    .where(eq(bankTransfers.transfer_id, Number(id)));
  if (!row) return jsonError("Transfer not found", 404);
  return Response.json({ transfer: bankTransferJson(row) });
}

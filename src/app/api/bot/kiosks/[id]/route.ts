import { eq } from "drizzle-orm";
import { db } from "@/db";
import { providerBoAccounts } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { jsonError, kioskJson } from "@/lib/bot-crud";

/** GET /api/bot/kiosks/:id — one kiosk with its back-office credentials. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const [row] = await db
    .select()
    .from(providerBoAccounts)
    .where(eq(providerBoAccounts.bo_account_id, Number(id)));
  // 404 (not 403) when out of a scoped key's company — don't reveal existence.
  if (!row || (auth.companyId != null && row.company_entity_id !== auth.companyId)) {
    return jsonError("Kiosk not found", 404);
  }

  return Response.json({ kiosk: kioskJson(row) });
}

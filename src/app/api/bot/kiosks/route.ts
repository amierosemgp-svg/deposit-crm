import { and, desc, eq, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { providerBoAccounts } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { kioskJson } from "@/lib/bot-crud";

/**
 * GET /api/bot/kiosks?company_entity_id=&game=&status=
 * Game-provider back-office (kiosk) accounts, including the login
 * credentials the bot needs to sign in and assign game credit.
 */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const companyId = url.searchParams.get("company_entity_id");
  const game = url.searchParams.get("game");
  const status = url.searchParams.get("status");

  const filters: SQL[] = [];
  // A company-scoped key only ever sees its own company's kiosks.
  if (auth.companyId != null) {
    filters.push(eq(providerBoAccounts.company_entity_id, auth.companyId));
  } else if (companyId) {
    filters.push(eq(providerBoAccounts.company_entity_id, Number(companyId)));
  }
  if (game) filters.push(eq(providerBoAccounts.game_name, game));
  if (status === "active" || status === "inactive") {
    filters.push(eq(providerBoAccounts.status, status));
  }

  const rows = await db
    .select()
    .from(providerBoAccounts)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(providerBoAccounts.bo_account_id));

  return Response.json({ count: rows.length, kiosks: rows.map(kioskJson) });
}

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, providerBoAccounts } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { bankAccountJson, jsonError, kioskJson } from "@/lib/bot-crud";

const schema = z.object({
  kind: z.enum(["kiosk", "bank_account"]),
  // accept `id`, or the kind-specific alias
  id: z.number().int().positive().optional(),
  kiosk_id: z.number().int().positive().optional(),
  bank_account_id: z.number().int().positive().optional(),
});

/**
 * POST /api/bot/heartbeat — the bot pings this to report that a kiosk login or
 * bank-account login is alive. Stamps `last_heartbeat_at = now`; the CRM shows
 * the kiosk/account as online while the last ping is recent (< ~5 min).
 *   { "kind": "kiosk", "id": 3 }  |  { "kind": "bank_account", "id": 5 }
 */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
  }
  const { kind } = parsed.data;
  const id =
    parsed.data.id ??
    (kind === "kiosk" ? parsed.data.kiosk_id : parsed.data.bank_account_id);
  if (!id) return jsonError("An id is required");

  const nowIso = new Date().toISOString();

  if (kind === "kiosk") {
    const [row] = await db
      .update(providerBoAccounts)
      .set({ last_heartbeat_at: nowIso })
      .where(eq(providerBoAccounts.bo_account_id, id))
      .returning();
    if (!row) return jsonError("Kiosk not found", 404);
    return Response.json({ kiosk: kioskJson(row) });
  }

  const [row] = await db
    .update(bankAccounts)
    .set({ last_heartbeat_at: nowIso })
    .where(eq(bankAccounts.account_id, id))
    .returning();
  if (!row) return jsonError("Bank account not found", 404);
  return Response.json({ bank_account: bankAccountJson(row) });
}

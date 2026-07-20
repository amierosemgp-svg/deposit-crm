import { and, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, entities } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { bankAccountJson, jsonError } from "@/lib/bot-crud";

/** GET /api/bot/bank-accounts?entity_id=&role=&status= */
export async function GET(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const entityId = url.searchParams.get("entity_id");
  const role = url.searchParams.get("role");
  const status = url.searchParams.get("status");

  const filters: SQL[] = [];
  if (entityId) filters.push(eq(bankAccounts.entity_id, Number(entityId)));
  if (role === "deposit" || role === "withdrawal") {
    filters.push(eq(bankAccounts.role, role));
  }
  if (status === "active" || status === "inactive") {
    filters.push(eq(bankAccounts.status, status));
  }

  const rows = await db
    .select()
    .from(bankAccounts)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(bankAccounts.account_id));

  return Response.json({ count: rows.length, bank_accounts: rows.map(bankAccountJson) });
}

const createSchema = z.object({
  entity_id: z.number().int().positive(),
  role: z.enum(["deposit", "withdrawal"]),
  bank_name: z.string().min(1),
  account_number: z.string().min(4),
  account_holder: z.string().min(1),
  label: z.string().optional(),
  login_id: z.string().optional(),
  login_password: z.string().optional(),
  login_pin: z.string().optional(),
  current_balance: z.number().min(0).default(0),
  status: z.enum(["active", "inactive"]).default("active"),
});

/** POST /api/bot/bank-accounts — attach a collection/payout account to an entity. */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
  }
  const body = parsed.data;

  const [entity] = await db
    .select()
    .from(entities)
    .where(eq(entities.entity_id, body.entity_id));
  if (!entity) return jsonError("Entity not found", 404);
  if (!["leader", "company", "main_company"].includes(entity.entity_type)) {
    return jsonError("Bank accounts belong to companies, leaders, or the main company");
  }

  const [created] = await db.insert(bankAccounts).values(body).returning();
  return Response.json({ bank_account: bankAccountJson(created) }, { status: 201 });
}

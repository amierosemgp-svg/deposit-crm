import { createHash, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { apiKeys, entities } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";

function requireAdmin(user: Awaited<ReturnType<typeof requireUser>>) {
  if (user.role !== "super_admin") {
    throw new AuthError(403, "Only the super admin manages API keys");
  }
}

/** Short alphanumeric code from an entity name, e.g. "Leader One" → "leaderone". */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "org";
}

const keyColumns = {
  key_id: apiKeys.key_id,
  label: apiKeys.label,
  hint: apiKeys.hint,
  status: apiKeys.status,
  allowed_ips: apiKeys.allowed_ips,
  company_entity_id: apiKeys.company_entity_id,
  last_used_at: apiKeys.last_used_at,
  created_at: apiKeys.created_at,
};

/** GET /api/api-keys — list keys (never returns the raw key, only the hint). */
export async function GET() {
  try {
    const user = await requireUser();
    requireAdmin(user);
    const rows = await db
      .select(keyColumns)
      .from(apiKeys)
      .orderBy(desc(apiKeys.created_at));
    return Response.json({ apiKeys: rows });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

const createSchema = z.object({
  label: z.string().min(2).max(80),
  company_entity_id: z.number().int().positive().nullable().optional(),
  allowed_ips: z.array(z.string()).optional(),
});

/**
 * POST /api/api-keys — mint a new key.
 * A company_entity_id scopes the key to that company; the generated key is
 * prefixed with its leader's code (e.g. "alpha_dbk_…") for identification.
 * Returns the plaintext key EXACTLY ONCE; only its hash is stored.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireAdmin(user);
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("A label is required");
    const { label, allowed_ips, company_entity_id } = parsed.data;

    // Resolve the scope + prefix from the company (and its leader parent).
    let prefix = "";
    let companyId: number | null = null;
    if (company_entity_id != null) {
      const [company] = await db
        .select()
        .from(entities)
        .where(eq(entities.entity_id, company_entity_id));
      if (!company || company.entity_type !== "company") {
        return jsonError("Scope must be a company entity");
      }
      companyId = company.entity_id;
      // Prefix from the parent leader's name; fall back to the company's.
      let prefixName = company.name;
      if (company.parent_entity_id != null) {
        const [parent] = await db
          .select()
          .from(entities)
          .where(eq(entities.entity_id, company.parent_entity_id));
        if (parent) prefixName = parent.name;
      }
      prefix = `${slug(prefixName)}_`;
    }

    const raw = `${prefix}dbk_${randomBytes(24).toString("hex")}`;
    const [created] = await db
      .insert(apiKeys)
      .values({
        key_hash: createHash("sha256").update(raw).digest("hex"),
        hint: `${raw.slice(0, 12)}…${raw.slice(-4)}`,
        label,
        company_entity_id: companyId,
        allowed_ips: allowed_ips?.length ? allowed_ips : null,
      })
      .returning(keyColumns);

    // The key itself is shown once and never stored in readable form — the log
    // gets the hint only, the same masked string the settings screen shows.
    await logActivity({
      category: "api_key",
      action: "api_key.created",
      summary: `API key "${created.label}" issued (${created.hint})`,
      actor: user,
      companyEntityId: created.company_entity_id,
      targetType: "api_key",
      targetId: created.key_id,
      targetLabel: created.label,
      context: {
        hint: created.hint,
        allowed_ips: created.allowed_ips,
        scoped_to_company: created.company_entity_id,
      },
    });

    // `key` is returned this one time; it is never retrievable again.
    return Response.json({ apiKey: created, key: raw }, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

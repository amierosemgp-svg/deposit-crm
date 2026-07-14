import { createHash, randomBytes } from "node:crypto";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

function requireAdmin(user: Awaited<ReturnType<typeof requireUser>>) {
  if (user.role !== "super_admin") {
    throw new AuthError(403, "Only the super admin manages API keys");
  }
}

/** GET /api/api-keys — list keys (never returns the raw key, only the hint). */
export async function GET() {
  try {
    const user = await requireUser();
    requireAdmin(user);
    const rows = await db
      .select({
        key_id: apiKeys.key_id,
        label: apiKeys.label,
        hint: apiKeys.hint,
        status: apiKeys.status,
        allowed_ips: apiKeys.allowed_ips,
        last_used_at: apiKeys.last_used_at,
        created_at: apiKeys.created_at,
      })
      .from(apiKeys)
      .orderBy(desc(apiKeys.created_at));
    return Response.json({ apiKeys: rows });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

const createSchema = z.object({
  label: z.string().min(2).max(80),
  allowed_ips: z.array(z.string()).optional(),
});

/**
 * POST /api/api-keys — mint a new key.
 * Returns the plaintext key EXACTLY ONCE; only its hash is stored.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireAdmin(user);
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("A label is required");
    const { label, allowed_ips } = parsed.data;

    const raw = `dbk_${randomBytes(24).toString("hex")}`;
    const [created] = await db
      .insert(apiKeys)
      .values({
        key_hash: createHash("sha256").update(raw).digest("hex"),
        hint: `${raw.slice(0, 8)}…${raw.slice(-4)}`,
        label,
        allowed_ips: allowed_ips?.length ? allowed_ips : null,
      })
      .returning({
        key_id: apiKeys.key_id,
        label: apiKeys.label,
        hint: apiKeys.hint,
        status: apiKeys.status,
        allowed_ips: apiKeys.allowed_ips,
        created_at: apiKeys.created_at,
      });

    // `key` is returned this one time; it is never retrievable again.
    return Response.json({ apiKey: created, key: raw }, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

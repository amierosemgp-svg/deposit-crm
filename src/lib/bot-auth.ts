import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";

export type BotAuthResult =
  | { ok: true; keyId: number; label: string }
  | { ok: false; response: Response };

/**
 * Authenticate a bot request via the X-API-Key header.
 * Optionally enforces the key's IP allowlist (when configured).
 */
export async function requireBotKey(request: Request): Promise<BotAuthResult> {
  const raw =
    request.headers.get("x-api-key") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!raw) {
    return {
      ok: false,
      response: Response.json(
        { error: "Missing API key (X-API-Key header)" },
        { status: 401 },
      ),
    };
  }

  const hash = createHash("sha256").update(raw).digest("hex");
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash));

  if (!key || key.status !== "active") {
    return {
      ok: false,
      response: Response.json({ error: "Invalid API key" }, { status: 401 }),
    };
  }

  if (key.allowed_ips && key.allowed_ips.length > 0) {
    const ip =
      request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "";
    if (!key.allowed_ips.includes(ip)) {
      return {
        ok: false,
        response: Response.json(
          { error: `IP ${ip || "unknown"} not allowed for this key` },
          { status: 403 },
        ),
      };
    }
  }

  // Fire-and-forget usage stamp
  db.update(apiKeys)
    .set({ last_used_at: new Date().toISOString() })
    .where(eq(apiKeys.key_id, key.key_id))
    .then(
      () => {},
      () => {},
    );

  return { ok: true, keyId: key.key_id, label: key.label };
}

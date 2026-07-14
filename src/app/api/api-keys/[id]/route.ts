import { eq } from "drizzle-orm";
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

const patchSchema = z.object({
  label: z.string().min(2).max(80).optional(),
  status: z.enum(["active", "inactive"]).optional(), // inactive = revoked
  allowed_ips: z.array(z.string()).nullable().optional(),
});

/** PATCH /api/api-keys/:id — rename, revoke/reactivate, set IP allowlist. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    requireAdmin(user);
    const { id } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const patch = parsed.data;

    const [updated] = await db
      .update(apiKeys)
      .set({
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.allowed_ips !== undefined
          ? { allowed_ips: patch.allowed_ips?.length ? patch.allowed_ips : null }
          : {}),
      })
      .where(eq(apiKeys.key_id, Number(id)))
      .returning({
        key_id: apiKeys.key_id,
        label: apiKeys.label,
        hint: apiKeys.hint,
        status: apiKeys.status,
        allowed_ips: apiKeys.allowed_ips,
        last_used_at: apiKeys.last_used_at,
        created_at: apiKeys.created_at,
      });
    if (!updated) return jsonError("Key not found", 404);
    return Response.json({ apiKey: updated });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/** DELETE /api/api-keys/:id — permanently remove a key. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    requireAdmin(user);
    const { id } = await params;
    await db.delete(apiKeys).where(eq(apiKeys.key_id, Number(id)));
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

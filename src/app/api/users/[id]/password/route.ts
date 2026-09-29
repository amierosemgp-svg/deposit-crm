import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { companyOfEntity, logActivity, requestContext } from "@/lib/activity-log";

/**
 * POST /api/users/:id/password — the super admin sets someone else's password,
 * for the account whose owner has forgotten theirs. Your own goes through
 * Settings → change password, which asks for the current one.
 */

const schema = z.object({
  new_password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const requester = await requireWriteUser();
    if (requester.role !== "super_admin") {
      throw new AuthError(403, "Only admins reset passwords");
    }
    const { id } = await params;
    const [target] = await db.select().from(users).where(eq(users.user_id, Number(id)));
    if (!target) throw new AuthError(404, "User not found");
    if (target.user_id === requester.user_id) {
      throw new AuthError(422, "Change your own password from Settings");
    }
    if (
      requester.ownedEntityIds !== null &&
      !requester.ownedEntityIds.includes(target.entity_id)
    ) {
      throw new AuthError(403, "That account belongs to another organisation");
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }

    await db
      .update(users)
      .set({
        password_hash: await bcrypt.hash(parsed.data.new_password, 10),
        updated_at: new Date().toISOString(),
      })
      .where(eq(users.user_id, target.user_id));

    // The password never touches the log — only who reset whose.
    await logActivity({
      category: "auth",
      action: "auth.password_reset",
      summary: `${requester.full_name} reset the password for "${target.username}"`,
      actor: requester,
      companyEntityId: await companyOfEntity(target.entity_id),
      targetType: "user",
      targetId: target.user_id,
      targetLabel: target.username,
      context: requestContext(request),
    });

    return Response.json({ ok: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

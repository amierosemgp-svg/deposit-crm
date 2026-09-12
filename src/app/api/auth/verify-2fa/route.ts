import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession } from "@/lib/auth";
import { logActivity, requestContext } from "@/lib/activity-log";
import { readDeviceId } from "@/lib/devices";
import { verifyLoginCode } from "@/lib/two-factor";

const bodySchema = z.object({
  challenge_id: z.number().int().positive(),
  code: z.string().min(4).max(10),
});

/**
 * POST /api/auth/verify-2fa — the second half of a login.
 *
 * The password was already checked when the challenge was issued; this only
 * has to prove the code. The session is minted here, so nothing exists until
 * both halves are in.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Enter the code from Telegram" }, { status: 400 });
  }
  const { challenge_id, code } = parsed.data;

  /**
   * The code has to come back from the browser that asked for it — otherwise
   * a code read over someone's shoulder, or out of their Telegram, could be
   * spent from another machine. verifyLoginCode checks this before it spends
   * the challenge, so a wrong-browser attempt can't burn the real user's code.
   */
  const fingerprint = await readDeviceId();
  const result = await verifyLoginCode(challenge_id, code, fingerprint);
  if (!result.ok) {
    if (result.wrongDevice) {
      await logActivity({
        category: "auth",
        action: "auth.two_factor_wrong_device",
        summary: "A sign-in code was entered from a different browser than it was issued to",
        context: requestContext(request),
      });
    }
    return Response.json(
      { error: result.error, retryable: result.retryable },
      { status: 401 },
    );
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.user_id, result.challenge.user_id));
  // The account could have been disabled in the minutes the code was in
  // flight — a valid code is not on its own permission to be here.
  if (!user || user.status !== "active") {
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  await db
    .update(users)
    .set({ last_login_at: new Date().toISOString() })
    .where(eq(users.user_id, user.user_id));

  await createSession({
    user_id: user.user_id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    entity_id: user.entity_id,
  });

  await logActivity({
    category: "auth",
    action: "auth.login",
    summary: `${user.full_name} signed in (Telegram code)`,
    actorUserId: user.user_id,
    actorLabel: user.username,
    targetType: "user",
    targetId: user.user_id,
    targetLabel: user.username,
    context: { ...requestContext(request), role: user.role, two_factor: true },
  });

  return Response.json({
    user: {
      user_id: user.user_id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      entity_id: user.entity_id,
    },
  });
}

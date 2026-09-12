import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { authChallenges, users } from "@/db/schema";
import { logActivity, requestContext } from "@/lib/activity-log";
import { clientIp } from "@/lib/ip-allow";
import { readDeviceId } from "@/lib/devices";
import { issueLoginCode, CODE_TTL_MINUTES } from "@/lib/two-factor";
import { sendLoginCode } from "@/lib/telegram";

const bodySchema = z.object({ challenge_id: z.number().int().positive() });

/**
 * POST /api/auth/resend-2fa — send the code again.
 *
 * Keyed off the outstanding challenge rather than the username, so this can't
 * be used to make the CRM message an arbitrary account's Telegram: you need a
 * challenge id, which only a correct password produces, from the same browser
 * that produced it. Issuing the new code retires the old one.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Nothing to resend" }, { status: 400 });

  const [challenge] = await db
    .select()
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.challenge_id, parsed.data.challenge_id),
        eq(authChallenges.purpose, "login"),
      ),
    );

  const stale = Response.json(
    { error: "That sign-in has expired — start again" },
    { status: 401 },
  );
  if (!challenge || challenge.consumed_at) return stale;
  if (new Date(challenge.expires_at).getTime() < Date.now()) return stale;

  const fingerprint = await readDeviceId();
  if (challenge.device_fingerprint && fingerprint !== challenge.device_fingerprint) {
    return stale;
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.user_id, challenge.user_id));
  if (!user || user.status !== "active" || !user.telegram_chat_id) return stale;

  const { challenge: fresh, code } = await issueLoginCode({
    userId: user.user_id,
    deviceFingerprint: fingerprint,
    ip: clientIp(request),
  });
  const sent = await sendLoginCode(user.telegram_chat_id, code, {
    ip: clientIp(request),
    minutes: CODE_TTL_MINUTES,
  });
  if (!sent.ok) {
    return Response.json(
      { error: "Couldn't send your code over Telegram. Try again, or ask an admin." },
      { status: 502 },
    );
  }

  await logActivity({
    category: "auth",
    action: "auth.two_factor_resent",
    summary: `${user.full_name} asked for a new sign-in code`,
    actorUserId: user.user_id,
    actorLabel: user.username,
    targetType: "user",
    targetId: user.user_id,
    targetLabel: user.username,
    context: requestContext(request),
  });

  return Response.json({
    challenge_id: fresh.challenge_id,
    expires_at: fresh.expires_at,
  });
}

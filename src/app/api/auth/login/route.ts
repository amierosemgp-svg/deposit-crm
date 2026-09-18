import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession } from "@/lib/auth";
import { logActivity, requestContext } from "@/lib/activity-log";
import { clientIp, ipAllowed } from "@/lib/ip-allow";
import {
  approveIfFirstDevice,
  getDevicePolicy,
  getOrCreateDeviceId,
  touchDevice,
} from "@/lib/devices";
import { issueLoginCode, CODE_TTL_MINUTES } from "@/lib/two-factor";
import { sendLoginCode } from "@/lib/telegram";

const bodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * POST /api/auth/login — password, then three checks before any session.
 *
 *   1. IP allowlist (per user, empty = anywhere)
 *   2. device binding (recorded always; refused only under "enforce")
 *   3. Telegram 2FA (per user, off until they enrol a chat)
 *
 * A user with none of them configured signs in exactly as before. When 2FA is
 * on, this returns `{ challenge_id }` and no cookie — /api/auth/verify-2fa
 * mints the session once the code comes back.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Username and password required" }, { status: 400 });
  }
  const { username, password } = parsed.data;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username.toLowerCase().trim()));

  // Rejected sign-ins are logged with the name that was tried, never the
  // password, and never a hint about which half was wrong — the log is for
  // spotting someone working through an admin account, not for debugging.
  const attempted = username.toLowerCase().trim();
  if (!user || user.status !== "active") {
    await logActivity({
      category: "auth",
      action: "auth.login_failed",
      summary: `Sign-in rejected for "${attempted}" — ${user ? "account is inactive" : "no such account"}`,
      actorLabel: attempted,
      context: requestContext(request),
    });
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await logActivity({
      category: "auth",
      action: "auth.login_failed",
      summary: `Sign-in rejected for "${attempted}" — wrong password`,
      actorLabel: attempted,
      companyEntityId: null,
      targetType: "user",
      targetId: user.user_id,
      targetLabel: user.username,
      context: requestContext(request),
    });
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent");

  // ---- 1. where they're signing in from ----
  if (!ipAllowed(ip, user.ip_allowlist)) {
    await logActivity({
      category: "auth",
      action: "auth.login_blocked_ip",
      summary: `${user.full_name} was refused — ${ip ?? "an unknown address"} is not on their allowed list`,
      actorUserId: user.user_id,
      actorLabel: user.username,
      targetType: "user",
      targetId: user.user_id,
      targetLabel: user.username,
      context: requestContext(request),
    });
    return Response.json(
      { error: "This network isn't allowed to sign in to that account" },
      { status: 403 },
    );
  }

  // ---- 2. which browser ----
  const fingerprint = await getOrCreateDeviceId();
  let device = await touchDevice({
    userId: user.user_id,
    fingerprint,
    userAgent,
    ip,
  });
  device = await approveIfFirstDevice(device);

  const policy = await getDevicePolicy();
  if (policy === "enforce" && device.status !== "approved") {
    await logActivity({
      category: "auth",
      action: "auth.login_blocked_device",
      summary:
        `${user.full_name} was refused — "${device.label ?? "a device"}" is ` +
        (device.status === "blocked" ? "blocked" : "waiting for approval"),
      actorUserId: user.user_id,
      actorLabel: user.username,
      targetType: "user",
      targetId: user.user_id,
      targetLabel: user.username,
      context: { ...requestContext(request), device_id: device.device_id },
    });
    return Response.json(
      {
        error:
          device.status === "blocked"
            ? "This device has been blocked. Talk to an administrator."
            : "This device isn't approved yet. An administrator has to allow it before you can sign in.",
      },
      { status: 403 },
    );
  }

  // ---- 3. the second factor ----
  if (user.two_factor_enabled && user.telegram_chat_id) {
    const { challenge, code } = await issueLoginCode({
      userId: user.user_id,
      deviceFingerprint: fingerprint,
      ip,
    });
    const sent = await sendLoginCode(user.telegram_chat_id, code, {
      ip,
      minutes: CODE_TTL_MINUTES,
    });
    if (!sent.ok) {
      // The code exists but never arrived — say so plainly rather than
      // leaving someone staring at a box no message will ever fill.
      await logActivity({
        category: "auth",
        action: "auth.two_factor_send_failed",
        summary: `Could not send ${user.full_name} a sign-in code — ${sent.error}`,
        actorUserId: user.user_id,
        actorLabel: user.username,
        targetType: "user",
        targetId: user.user_id,
        targetLabel: user.username,
        context: requestContext(request),
      });
      return Response.json(
        { error: "Couldn't send your code over Telegram. Try again, or ask an admin." },
        { status: 502 },
      );
    }

    await logActivity({
      category: "auth",
      action: "auth.two_factor_sent",
      summary: `${user.full_name} passed their password — code sent to Telegram`,
      actorUserId: user.user_id,
      actorLabel: user.username,
      targetType: "user",
      targetId: user.user_id,
      targetLabel: user.username,
      context: requestContext(request),
    });

    return Response.json({
      two_factor_required: true,
      challenge_id: challenge.challenge_id,
      expires_at: challenge.expires_at,
      // Enough to say where it went, not enough to identify the account.
      telegram_hint: user.telegram_username ? `@${user.telegram_username}` : "your linked Telegram",
    });
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
    summary: `${user.full_name} signed in`,
    actorUserId: user.user_id,
    actorLabel: user.username,
    targetType: "user",
    targetId: user.user_id,
    targetLabel: user.username,
    context: { ...requestContext(request), role: user.role, device_id: device.device_id },
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

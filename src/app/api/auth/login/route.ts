import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession } from "@/lib/auth";
import { logActivity, requestContext } from "@/lib/activity-log";

const bodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

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
    context: { ...requestContext(request), role: user.role },
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

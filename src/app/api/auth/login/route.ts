import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession } from "@/lib/auth";

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

  if (!user || user.status !== "active") {
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
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

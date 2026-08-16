import { destroySession, getSession } from "@/lib/auth";
import { logActivity, requestContext } from "@/lib/activity-log";

export async function POST(request: Request) {
  // Read the session before it's destroyed — afterwards there's no way to say
  // who signed out.
  const session = await getSession();
  await destroySession();
  if (session) {
    await logActivity({
      category: "auth",
      action: "auth.logout",
      summary: `${session.full_name} signed out`,
      actorUserId: session.user_id,
      actorLabel: session.username,
      targetType: "user",
      targetId: session.user_id,
      targetLabel: session.username,
      context: requestContext(request),
    });
  }
  return Response.json({ ok: true });
}

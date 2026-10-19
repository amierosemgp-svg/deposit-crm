import { destroySession, getSession } from "@/lib/auth";
import { logActivity, requestContext } from "@/lib/activity-log";
import { closeWorkSession, isClocked } from "@/lib/work-sessions";

export async function POST(request: Request) {
  // Read the session before it's destroyed — afterwards there's no way to say
  // who signed out.
  const session = await getSession();
  await destroySession();
  if (session && isClocked(session.role)) await closeWorkSession(session.user_id, "logout");
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

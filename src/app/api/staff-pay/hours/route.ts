import { authErrorResponse, AuthError, requireUser } from "@/lib/auth";
import { db } from "@/db";
import { jsonError } from "@/lib/api-helpers";
import {
  attendanceFor,
  csCasino,
  dayMarks,
  firstDays,
  inCasinoScope,
  isMonth,
  monthBounds,
  rollupSessions,
  sessionsFor,
  toWorked,
} from "@/lib/salary";

/**
 * GET /api/staff-pay/hours?user_id=&month=YYYY-MM — one CS's month, day by
 * day: worked or off, the leader's marks, what each day off cost, and the
 * sessions behind it. A CS may read their own.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sp = new URL(request.url).searchParams;
    const userId = Number(sp.get("user_id"));
    const month = sp.get("month") ?? "";
    if (!userId || !isMonth(month)) return jsonError("user_id and month (YYYY-MM) required");

    const cs = await csCasino(db, userId);
    if (!cs) return jsonError("That account isn't a CS agent with a desk", 404);
    if (userId !== user.user_id && !inCasinoScope(user, cs.casinoId)) {
      throw new AuthError(403, "That CS is outside your organisation");
    }

    const [sessions, marks, firsts] = await Promise.all([
      sessionsFor(db, [userId], month),
      dayMarks(db, [userId], month),
      firstDays(db, [userId]),
    ]);
    const { startMs, endMs } = monthBounds(month);
    const worked = toWorked(rollupSessions(sessions, startMs, endMs));
    return Response.json({
      user_id: userId,
      full_name: cs.user.full_name,
      month,
      worked,
      attendance: attendanceFor(month, worked.daily, marks.get(userId) ?? {}, firsts.get(userId) ?? null),
      sessions: sessions.sort((a, b) => a.started_at.localeCompare(b.started_at)),
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

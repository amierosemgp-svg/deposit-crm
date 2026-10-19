import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { workSessions } from "@/db/schema";

/**
 * The CS clock. See `workSessions` in the schema for the model; in short, time
 * counts from sign-in to the last moment they touched the page, and five idle
 * minutes lock the screen and stop it.
 */

/** Five minutes without input locks the page and stops the clock. */
export const IDLE_LOCK_MS = 5 * 60_000;

/**
 * Slack on the server's side of the idle check. The page locks itself at five
 * minutes; heartbeats are throttled, so the last one can land up to half a
 * minute before the last real input. Without slack a CS still typing could be
 * locked out by the server a moment before the page would have.
 */
const SERVER_GRACE_MS = 90_000;

/** Only CS agents are on the clock — leaders and admins are not paid by the hour. */
export function isClocked(role: string): boolean {
  return role === "cs_agent";
}

type Db = typeof db;
type Txn = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function openRow(q: Db | Txn, userId: number) {
  const [row] = await q
    .select()
    .from(workSessions)
    .where(and(eq(workSessions.user_id, userId), isNull(workSessions.ended_at)))
    .orderBy(desc(workSessions.started_at))
    .limit(1);
  return row ?? null;
}

/**
 * Start the clock — on sign-in, and on unlocking the idle screen.
 *
 * Anything still open is closed first, at its own last activity: a browser
 * closed without signing out, or a second sign-in on another machine. Either
 * way the old session's time already stopped where it stopped.
 */
export async function openWorkSession(userId: number): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async (txn) => {
    const open = await txn
      .select()
      .from(workSessions)
      .where(and(eq(workSessions.user_id, userId), isNull(workSessions.ended_at)))
      .for("update");
    for (const s of open) {
      await txn
        .update(workSessions)
        .set({ ended_at: s.last_active_at, end_reason: "replaced" })
        .where(eq(workSessions.session_id, s.session_id));
    }
    await txn.insert(workSessions).values({ user_id: userId, started_at: now, last_active_at: now });
  });
}

/**
 * The page's heartbeat: they did something.
 *
 * Returns `locked: true` when there is no live session to extend — never
 * opened, closed by a sign-in elsewhere, or idle past the limit (closed here,
 * at its last activity). The page then shows the lock screen; nothing but the
 * password brings the clock back.
 */
export async function touchWorkSession(userId: number): Promise<{ locked: boolean }> {
  const open = await openRow(db, userId);
  if (!open) return { locked: true };
  const now = Date.now();
  if (now - new Date(open.last_active_at).getTime() > IDLE_LOCK_MS + SERVER_GRACE_MS) {
    await db
      .update(workSessions)
      .set({ ended_at: open.last_active_at, end_reason: "idle" })
      .where(eq(workSessions.session_id, open.session_id));
    return { locked: true };
  }
  await db
    .update(workSessions)
    .set({ last_active_at: new Date(now).toISOString() })
    .where(eq(workSessions.session_id, open.session_id));
  return { locked: false };
}

/** Is the clock running, without moving it — the page asking on load. */
export async function workSessionLive(userId: number): Promise<boolean> {
  const open = await openRow(db, userId);
  return (
    !!open && Date.now() - new Date(open.last_active_at).getTime() <= IDLE_LOCK_MS + SERVER_GRACE_MS
  );
}

/**
 * Stop the clock.
 *
 * Signing out is itself activity, so it ends now. Idling ends at the last
 * thing they did — the five minutes spent away are not work.
 */
export async function closeWorkSession(userId: number, reason: "logout" | "idle"): Promise<void> {
  const open = await openRow(db, userId);
  if (!open) return;
  const now = new Date().toISOString();
  // A laptop lid closed for an hour pauses the page's own lock timer; signing
  // out after it must not count the hour.
  const stale =
    Date.now() - new Date(open.last_active_at).getTime() > IDLE_LOCK_MS + SERVER_GRACE_MS;
  await db
    .update(workSessions)
    .set(
      reason === "logout" && !stale
        ? { ended_at: now, last_active_at: now, end_reason: "logout" }
        : { ended_at: open.last_active_at, end_reason: "idle" },
    )
    .where(eq(workSessions.session_id, open.session_id));
}

import { cookies } from "next/headers";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { entities, users } from "@/db/schema";
import {
  SESSION_COOKIE,
  SESSION_HOURS,
  signSessionToken,
  verifySessionToken,
  type SessionPayload,
} from "./session";

export type { SessionPayload };

export type AuthedUser = SessionPayload & {
  /** Company entity IDs this user may see. null = unrestricted (super_admin / viewer). */
  companyIds: number[] | null;
  /** Entity IDs (companies + leader itself) whose bank accounts this user manages. */
  ownedEntityIds: number[] | null;
};

export async function createSession(payload: SessionPayload) {
  const token = await signSessionToken(payload);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_HOURS * 3600,
    path: "/",
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/**
 * Resolve the entity-visibility scope for a session user.
 * - super_admin / viewer → everything (null)
 * - company_leader → all company entities under their leader entity
 * - cs_agent → the single company their cs entity belongs to
 */
export async function resolveScope(session: SessionPayload): Promise<AuthedUser> {
  if (session.role === "super_admin" || session.role === "viewer") {
    return { ...session, companyIds: null, ownedEntityIds: null };
  }
  if (session.role === "company_leader") {
    const companies = await db
      .select({ id: entities.entity_id })
      .from(entities)
      .where(eq(entities.parent_entity_id, session.entity_id));
    const companyIds = companies.map((c) => c.id);
    return {
      ...session,
      companyIds,
      ownedEntityIds: [session.entity_id, ...companyIds],
    };
  }
  // cs_agent — their entity is a cs node whose parent is the company
  const [self] = await db
    .select({ parent: entities.parent_entity_id })
    .from(entities)
    .where(eq(entities.entity_id, session.entity_id));
  const companyId = self?.parent ?? null;
  return {
    ...session,
    companyIds: companyId ? [companyId] : [],
    ownedEntityIds: companyId ? [companyId] : [],
  };
}

/** For route handlers: returns the authed user or throws AuthError. */
export async function requireUser(): Promise<AuthedUser> {
  const session = await getSession();
  if (!session) throw new AuthError(401, "Not authenticated");
  return resolveScope(session);
}

export async function requireWriteUser(): Promise<AuthedUser> {
  const user = await requireUser();
  if (user.role === "viewer") throw new AuthError(403, "Read-only account");
  return user;
}

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function authErrorResponse(e: unknown): Response | null {
  if (e instanceof AuthError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return null;
}

/** Load fresh user rows (for joining handled_by names etc.). */
export async function loadUsersByIds(ids: number[]) {
  if (!ids.length) return [];
  return db.select().from(users).where(inArray(users.user_id, ids));
}

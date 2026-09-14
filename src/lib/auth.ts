import { cookies } from "next/headers";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { entities, users } from "@/db/schema";
import { DuplicateGameAccountError } from "./game-name";
import {
  SESSION_COOKIE,
  SESSION_HOURS,
  signSessionToken,
  verifySessionToken,
  type SessionPayload,
} from "./session";
import { getSessionEpoch } from "@/lib/kill-switch";

export type { SessionPayload };

export type AuthedUser = SessionPayload & {
  /**
   * Company entity IDs this user may see.
   *
   * `null` means unrestricted. Nothing produces it any more — every role is
   * scoped to its own organisation (see resolveScope) — but the branches that
   * handle it are left in place as a safe default rather than removed.
   */
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
 * - super_admin / viewer → their own main company and everything under it
 * - company_leader → all company entities under their leader entity
 * - cs_agent → the single company their cs entity belongs to
 *
 * A super admin is the super admin *of one organisation*, not of the database.
 * This used to hand them `null` — unrestricted — which was indistinguishable
 * from correct while exactly one main company existed. The moment a second one
 * did, every super admin and viewer could read and edit the other's players,
 * deposits, bank accounts and entity tree. Scope now walks up to the main
 * company the account belongs to and stops there.
 */
export async function resolveScope(session: SessionPayload): Promise<AuthedUser> {
  if (session.role === "super_admin" || session.role === "viewer") {
    const all = await db
      .select({
        id: entities.entity_id,
        parent: entities.parent_entity_id,
        type: entities.entity_type,
      })
      .from(entities);
    const byId = new Map(all.map((e) => [e.id, e]));

    // Up to the root of this account's own tree. The bound stops a parent
    // cycle from hanging the request; a broken chain falls back to the
    // account's own entity, which scopes to nothing rather than to everything.
    let root = byId.get(session.entity_id);
    for (let hops = 0; root?.parent && hops < 20; hops++) {
      root = byId.get(root.parent) ?? root;
    }
    const rootId = root?.id ?? session.entity_id;

    // Down again: every descendant of that root.
    const subtree = new Set<number>([rootId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of all) {
        if (e.parent && subtree.has(e.parent) && !subtree.has(e.id)) {
          subtree.add(e.id);
          grew = true;
        }
      }
    }

    return {
      ...session,
      companyIds: all
        .filter((e) => e.type === "company" && subtree.has(e.id))
        .map((e) => e.id),
      ownedEntityIds: [...subtree],
    };
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
  // Kill-switch epoch: a token minted before the last emergency sign-out is
  // dead, whatever its own expiry says. `iat` rides in the JWT via
  // setIssuedAt(), in seconds.
  const epoch = await getSessionEpoch();
  if (epoch) {
    const iatMs =
      ((session as unknown as { iat?: number }).iat ?? 0) * 1000;
    if (iatMs < epoch) {
      throw new AuthError(401, "Signed out by an administrator — please sign in again");
    }
  }
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
  // A player may hold one account per game; the message names the offenders.
  if (e instanceof DuplicateGameAccountError) {
    return Response.json({ error: e.message }, { status: 409 });
  }
  return null;
}

/** Load fresh user rows (for joining handled_by names etc.). */
export async function loadUsersByIds(ids: number[]) {
  if (!ids.length) return [];
  return db.select().from(users).where(inArray(users.user_id, ids));
}


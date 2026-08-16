import { eq } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, entities } from "@/db/schema";
import type { AuthedUser } from "./auth";

export type ActivityCategory =
  | "auth"
  | "user"
  | "entity"
  | "player"
  | "bank_account"
  | "kiosk"
  | "bonus"
  | "api_key"
  | "settings"
  | "expense"
  | "other";

export type FieldChange = { field: string; from: unknown; to: unknown };

export type ActivityEntry = {
  category: ActivityCategory;
  /** Dotted machine tag: "bonus.updated", "auth.login_failed". */
  action: string;
  /** The line a person reads. Write it in the words that are true right now. */
  summary: string;
  actor?: AuthedUser | null;
  /** When the actor isn't an authed session — sign-in, where it's the user row. */
  actorUserId?: number | null;
  /** Use when there is no user row — a rejected sign-in, or the system. */
  actorLabel?: string | null;
  /** Null/undefined = system-wide; only the super admin sees those rows. */
  companyEntityId?: number | null;
  targetType?: string;
  targetId?: number | null;
  targetLabel?: string | null;
  changes?: FieldChange[];
  context?: Record<string, unknown>;
};

/**
 * Record an action in the system log.
 *
 * **Never throws.** A failure to write the log must not fail the thing being
 * logged — refusing a password change because the audit insert deadlocked
 * would be a worse outcome than a missing line. Failures go to the server
 * console, where they show up in Vercel's logs.
 *
 * Fire-and-forget is deliberately NOT the default: `await` it so the row is in
 * before the response goes out, otherwise a serverless function can freeze
 * mid-insert once it has replied.
 */
export async function logActivity(entry: ActivityEntry): Promise<void> {
  try {
    await db.insert(activityLog).values({
      category: entry.category,
      action: entry.action,
      summary: entry.summary,
      actor_user_id: entry.actor?.user_id ?? entry.actorUserId ?? null,
      actor_label: entry.actorLabel ?? entry.actor?.username ?? null,
      company_entity_id: entry.companyEntityId ?? null,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      target_label: entry.targetLabel ?? null,
      // An empty diff is noise — an edit that changed nothing reads better as
      // no changes at all than as "[]".
      changes: entry.changes?.length ? entry.changes : null,
      context: entry.context ?? null,
    });
  } catch (e) {
    console.error("activity log write failed:", entry.action, e);
  }
}

/** Fields whose values must never reach the log. */
const SECRET_FIELDS = new Set([
  "password",
  "password_hash",
  "new_password",
  "current_password",
  "login_password",
  "login_pin",
  "bo_password",
  "bo_pin",
  "key",
  "key_hash",
  "token",
]);

/**
 * What actually changed, field by field.
 *
 * Only fields present in `after` are compared, so a PATCH that names three
 * fields can't report the other twenty as unchanged noise. Secrets are
 * recorded as having changed without either value — that a PIN was edited is
 * exactly what an audit needs; what it was edited to is not.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, next] of Object.entries(after)) {
    if (next === undefined) continue;
    const prev = before[field];
    // Compare structurally: jsonb columns (bank_accounts, game_accounts) are
    // objects, and `!==` would report every save as a change.
    if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) continue;
    changes.push(
      SECRET_FIELDS.has(field)
        ? { field, from: "•••", to: "•••" }
        : { field, from: prev ?? null, to: next },
    );
  }
  return changes;
}

/** "10 → 12", for folding a diff into a one-line summary. */
export function describeChanges(changes: FieldChange[]): string {
  return changes
    .map((c) => `${c.field} ${format(c.from)} → ${format(c.to)}`)
    .join(", ");
}

function format(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return Array.isArray(value) ? `${value.length} items` : "…";
  return String(value);
}

/**
 * The client's IP and browser, for sign-in records.
 *
 * Behind Vercel the socket address is the proxy's, so the forwarded header is
 * the only real source; the first entry is the client, the rest are hops.
 */
export function requestContext(request: Request): Record<string, unknown> {
  const forwarded = request.headers.get("x-forwarded-for");
  return {
    ip: forwarded?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? null,
    user_agent: request.headers.get("user-agent")?.slice(0, 200) ?? null,
  };
}

/**
 * The company an entity belongs to, for scoping a log row to a leader.
 *
 * A CS desk is scoped to its parent company; a company to itself. Leaders and
 * the main company scope to nothing — those actions are system-level, and only
 * the super admin sees them.
 */
export async function companyOfEntity(
  entityId: number | null | undefined,
): Promise<number | null> {
  if (!entityId) return null;
  const [entity] = await db
    .select()
    .from(entities)
    .where(eq(entities.entity_id, entityId));
  if (!entity) return null;
  if (entity.entity_type === "company") return entity.entity_id;
  if (entity.entity_type === "cs") return entity.parent_entity_id;
  return null;
}

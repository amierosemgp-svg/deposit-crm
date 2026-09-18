/**
 * One-time codes: the login second factor, and Telegram enrolment.
 *
 * A challenge is a short-lived row, not a session — nothing is signed in until
 * the code comes back. Only the hash is stored, on the same reasoning as a
 * password: a leaked table shouldn't hand over live codes.
 *
 * The guards are the boring ones that matter. A code expires in minutes, is
 * consumed on first correct use, and a fixed number of wrong answers kills the
 * challenge rather than the account — locking the account would hand anyone
 * who knows a username a way to lock staff out mid-shift. Issuing a new code
 * retires the previous one, so the last message received is the only one that
 * works.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { authChallenges } from "@/db/schema";

/** How long a login code lives. Long enough to fetch a phone, short enough. */
export const CODE_TTL_MINUTES = 5;
/** An enrolment link is opened at a desk, so it gets longer. */
export const LINK_TTL_MINUTES = 15;
/** Wrong answers before the challenge is torn down and a new one is needed. */
export const MAX_ATTEMPTS = 5;

export type Challenge = typeof authChallenges.$inferSelect;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** A 6-digit code, uniformly random — no Math.random for a credential. */
function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Retire whatever is outstanding, so only the newest code can be used. */
async function retireOpen(userId: number, purpose: Challenge["purpose"]) {
  await db
    .update(authChallenges)
    .set({ consumed_at: new Date().toISOString() })
    .where(
      and(
        eq(authChallenges.user_id, userId),
        eq(authChallenges.purpose, purpose),
        isNull(authChallenges.consumed_at),
      ),
    );
}

/**
 * Issue a login code. Returns the row and the plaintext code — the caller
 * sends the code to Telegram and must not keep it.
 */
export async function issueLoginCode(input: {
  userId: number;
  deviceFingerprint?: string | null;
  ip?: string | null;
}): Promise<{ challenge: Challenge; code: string }> {
  await retireOpen(input.userId, "login");
  const code = newCode();
  const [challenge] = await db
    .insert(authChallenges)
    .values({
      user_id: input.userId,
      purpose: "login",
      code_hash: hashCode(code),
      device_fingerprint: input.deviceFingerprint ?? null,
      ip: input.ip ?? null,
      expires_at: minutesFromNow(CODE_TTL_MINUTES),
    })
    .returning();
  return { challenge, code };
}

export type VerifyResult =
  | { ok: true; challenge: Challenge }
  | { ok: false; error: string; retryable: boolean; wrongDevice?: true };

/**
 * Check a login code and consume it.
 *
 * "Expired or already used" and "no such challenge" answer alike on purpose:
 * the code is the secret, and distinguishing them only helps someone probing.
 *
 * `deviceFingerprint` is the browser presenting the code, and it is checked
 * *before* the code is compared or spent. Order matters: a correct code
 * arriving from the wrong browser must not consume the challenge, or anyone
 * who glimpsed the code could burn it and leave the real user unable to
 * finish signing in. Nothing about the code leaks by refusing first — the
 * comparison hasn't happened yet.
 */
export async function verifyLoginCode(
  challengeId: number,
  code: string,
  deviceFingerprint: string | null,
): Promise<VerifyResult> {
  const [challenge] = await db
    .select()
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.challenge_id, challengeId),
        eq(authChallenges.purpose, "login"),
      ),
    );

  const dead = { ok: false as const, error: "That code has expired — sign in again", retryable: false };
  if (!challenge || challenge.consumed_at) return dead;
  if (new Date(challenge.expires_at).getTime() < Date.now()) return dead;

  // Wrong browser: refused without touching the challenge, so the legitimate
  // one can still use its code. Not counted as a wrong guess either — no
  // guess was made.
  if (challenge.device_fingerprint && deviceFingerprint !== challenge.device_fingerprint) {
    return {
      ok: false,
      error: "That code was issued to a different browser — sign in again here.",
      retryable: false,
      wrongDevice: true,
    };
  }

  if (challenge.attempts >= MAX_ATTEMPTS) {
    await db
      .update(authChallenges)
      .set({ consumed_at: new Date().toISOString() })
      .where(eq(authChallenges.challenge_id, challenge.challenge_id));
    return { ok: false, error: "Too many wrong codes — sign in again", retryable: false };
  }

  const given = Buffer.from(hashCode(code.trim()), "hex");
  const want = Buffer.from(challenge.code_hash ?? "", "hex");
  const matches = given.length === want.length && timingSafeEqual(given, want);

  if (!matches) {
    const [bumped] = await db
      .update(authChallenges)
      .set({ attempts: sql`${authChallenges.attempts} + 1` })
      .where(eq(authChallenges.challenge_id, challenge.challenge_id))
      .returning();
    const left = MAX_ATTEMPTS - bumped.attempts;
    return {
      ok: false,
      error:
        left > 0
          ? `Wrong code — ${left} ${left === 1 ? "try" : "tries"} left`
          : "Too many wrong codes — sign in again",
      retryable: left > 0,
    };
  }

  const [consumed] = await db
    .update(authChallenges)
    .set({ consumed_at: new Date().toISOString() })
    .where(eq(authChallenges.challenge_id, challenge.challenge_id))
    .returning();
  return { ok: true, challenge: consumed };
}

/**
 * Start Telegram enrolment: a token the user carries to the bot as
 * `/start <token>`, which is how the CRM learns their chat id. Nobody knows
 * their own chat id, so it can't simply be typed into a form.
 */
export async function issueLinkToken(userId: number): Promise<string> {
  await retireOpen(userId, "telegram_link");
  const token = randomBytes(24).toString("hex");
  await db.insert(authChallenges).values({
    user_id: userId,
    purpose: "telegram_link",
    link_token: token,
    expires_at: minutesFromNow(LINK_TTL_MINUTES),
  });
  return token;
}

/** Redeem an enrolment token. Null when unknown, expired or already used. */
export async function consumeLinkToken(token: string): Promise<Challenge | null> {
  const [challenge] = await db
    .select()
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.link_token, token),
        eq(authChallenges.purpose, "telegram_link"),
      ),
    );
  if (!challenge || challenge.consumed_at) return null;
  if (new Date(challenge.expires_at).getTime() < Date.now()) return null;

  const [consumed] = await db
    .update(authChallenges)
    .set({ consumed_at: new Date().toISOString() })
    .where(eq(authChallenges.challenge_id, challenge.challenge_id))
    .returning();
  return consumed;
}

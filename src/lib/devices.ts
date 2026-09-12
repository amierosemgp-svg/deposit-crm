/**
 * Device binding — which browsers may sign in to an account.
 *
 * There is no MAC address to be had here. A web page cannot read one at any
 * privilege level, so "this machine" is approximated the only way the web
 * allows: a random id minted on first sign-in and kept in a long-lived,
 * httpOnly cookie. It identifies a browser profile, not hardware — clearing
 * cookies, a private window or a second browser all read as a new device and
 * come back round for approval. For the desk machines this is meant to
 * govern, that is the behaviour wanted; it is not a defence against someone
 * who controls the machine.
 *
 * Enforcement is a separate decision from recording. Devices are recorded
 * from the moment this ships, but `device_policy` starts at "off": every
 * device signs in and simply lands on the list. An admin approves the real
 * machines, then switches the policy to "enforce" — doing it the other way
 * round would lock out the whole desk at once.
 */

import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { settings, userDevices } from "@/db/schema";

export const DEVICE_COOKIE = "crm_device";
/** Two years — a desk machine shouldn't be re-approved every few weeks. */
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 730;

export const DEVICE_POLICY_KEY = "device_policy";
export type DevicePolicy = "off" | "enforce";

/**
 * "off"  — record every device, refuse none (the default, and what an
 *          existing database has until someone changes it).
 * "enforce" — only devices an admin approved may sign in.
 */
export async function getDevicePolicy(): Promise<DevicePolicy> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, DEVICE_POLICY_KEY));
  return row?.value === "enforce" ? "enforce" : "off";
}

/**
 * This browser's device id, minting and setting one if it has none.
 *
 * 32 random bytes: a client can set the cookie to anything it likes, but
 * guessing an id that is already approved is the same problem as guessing a
 * session token, and inventing a fresh one only produces a pending device.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(DEVICE_COOKIE)?.value;
  if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;

  const id = randomBytes(32).toString("hex");
  store.set(DEVICE_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: DEVICE_COOKIE_MAX_AGE,
    path: "/",
  });
  return id;
}

/** The device id already on this request, if any — never mints one. */
export async function readDeviceId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(DEVICE_COOKIE)?.value;
  return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** "Chrome on macOS" — a name a user recognises their own machine by. */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const os =
    /Windows/.test(ua) ? "Windows"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "unknown OS";
  return `${browser} on ${os}`;
}

export type DeviceRow = typeof userDevices.$inferSelect;

/**
 * Record this browser against the user and hand back the row.
 *
 * Called on every sign-in attempt that gets past the password, so the list
 * shows what is actually being used and when — including a device that is
 * being refused, which is exactly the one an admin needs to see.
 */
export async function touchDevice(input: {
  userId: number;
  fingerprint: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<DeviceRow> {
  const now = new Date().toISOString();
  const ua = input.userAgent?.slice(0, 300) ?? null;

  const [existing] = await db
    .select()
    .from(userDevices)
    .where(
      and(
        eq(userDevices.user_id, input.userId),
        eq(userDevices.fingerprint, input.fingerprint),
      ),
    );

  if (existing) {
    const [updated] = await db
      .update(userDevices)
      .set({ last_seen_at: now, last_ip: input.ip ?? existing.last_ip, user_agent: ua ?? existing.user_agent })
      .where(eq(userDevices.device_id, existing.device_id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(userDevices)
    .values({
      user_id: input.userId,
      fingerprint: input.fingerprint,
      label: describeDevice(ua),
      user_agent: ua,
      last_ip: input.ip ?? null,
      status: "pending",
      first_seen_at: now,
      last_seen_at: now,
    })
    .returning();
  return created;
}

/**
 * The user's very first device is approved as it's created.
 *
 * Without this, switching the policy to "enforce" on a team that has never
 * had a device list would refuse everyone including the admin who threw the
 * switch. The first browser an account ever signs in from is, by definition,
 * the one that account is being set up on.
 */
export async function approveIfFirstDevice(
  device: DeviceRow,
): Promise<DeviceRow> {
  if (device.status !== "pending") return device;
  const owned = await db
    .select({ id: userDevices.device_id })
    .from(userDevices)
    .where(eq(userDevices.user_id, device.user_id));
  if (owned.length !== 1) return device;

  const [updated] = await db
    .update(userDevices)
    .set({ status: "approved", approved_at: new Date().toISOString() })
    .where(eq(userDevices.device_id, device.device_id))
    .returning();
  return updated;
}

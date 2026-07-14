// Edge-safe session helpers — no DB imports (used by proxy.ts).
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "crm_session";
export const SESSION_HOURS = 12;

export type SessionPayload = {
  user_id: number;
  username: string;
  full_name: string;
  role: "super_admin" | "company_leader" | "cs_agent" | "viewer";
  entity_id: number;
};

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return new TextEncoder().encode(s);
}

export async function signSessionToken(payload: SessionPayload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secret());
}

export async function verifySessionToken(
  token: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

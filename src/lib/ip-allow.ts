/**
 * Per-user IP allowlists.
 *
 * A list holds plain addresses ("203.0.113.7") and CIDR ranges
 * ("203.0.113.0/24", "2001:db8::/32"), v4 and v6. An empty list means
 * "anywhere", which is every user's default — the check is opt-in per account.
 *
 * The address itself comes from x-forwarded-for, which a client can forge
 * unless something trusted rewrites it. On Vercel the edge does, so the first
 * hop is the real client; behind another proxy, confirm that before relying on
 * this as a control rather than a speed bump.
 */

/** The client address for a request, or null when nothing reported one. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip")?.trim() || null;
}

/** IPv4 dotted quad → its 32-bit value, or null if it isn't one. */
function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/**
 * An IPv6 address → its 16 bytes, or null. Handles "::" compression and the
 * IPv4-mapped tail ("::ffff:203.0.113.7") that a dual-stack proxy reports.
 */
function v6ToBytes(ip: string): Uint8Array | null {
  let text = ip.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  // Zone index ("fe80::1%eth0") means nothing here.
  text = text.split("%")[0];
  if (!text.includes(":")) return null;

  // A trailing dotted quad becomes its two hex groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = v4ToInt(tail);
    if (v4 === null) return null;
    const hi = (v4 >>> 16).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rear = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? head.length + rear.length : head.length;
  if (groups > 8 || (halves.length === 1 && groups !== 8)) return null;

  const all = [
    ...head,
    ...Array<string>(halves.length === 2 ? 8 - groups : 0).fill("0"),
    ...rear,
  ];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = all[i] === "" ? "0" : all[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

/** The address as 16 bytes — IPv4 goes in as its v6-mapped form. */
function toBytes(ip: string): Uint8Array | null {
  const v4 = v4ToInt(ip.trim());
  if (v4 !== null) {
    const bytes = new Uint8Array(16);
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    bytes[12] = (v4 >>> 24) & 0xff;
    bytes[13] = (v4 >>> 16) & 0xff;
    bytes[14] = (v4 >>> 8) & 0xff;
    bytes[15] = v4 & 0xff;
    return bytes;
  }
  return v6ToBytes(ip);
}

/** Do two addresses agree on their first `bits` bits? */
function sharePrefix(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  const whole = bits >> 3;
  for (let i = 0; i < whole; i++) if (a[i] !== b[i]) return false;
  const rest = bits & 7;
  if (rest === 0) return true;
  const mask = 0xff << (8 - rest);
  return (a[whole] & mask) === (b[whole] & mask);
}

/**
 * Does `ip` fall inside one entry — a bare address or a CIDR range?
 *
 * A v4 range is compared in v6-mapped space, so its prefix shifts by the 96
 * bits of the mapping prefix; "203.0.113.0/24" is therefore /120 here.
 */
export function ipMatches(ip: string, entry: string): boolean {
  const target = toBytes(ip);
  if (!target) return false;

  const slash = entry.indexOf("/");
  if (slash === -1) {
    const one = toBytes(entry);
    return Boolean(one && sharePrefix(target, one, 128));
  }

  const base = entry.slice(0, slash).trim();
  const prefix = Number(entry.slice(slash + 1).trim());
  if (!Number.isInteger(prefix) || prefix < 0) return false;
  const baseBytes = toBytes(base);
  if (!baseBytes) return false;

  const isV4 = v4ToInt(base) !== null;
  if (prefix > (isV4 ? 32 : 128)) return false;
  return sharePrefix(target, baseBytes, isV4 ? 96 + prefix : prefix);
}

/**
 * May this address sign in? An empty list allows everything.
 *
 * A user who *has* a list and arrives with no address at all is refused: the
 * point of setting one is that unknown origins don't get in.
 */
export function ipAllowed(ip: string | null, allowlist: string[] | null): boolean {
  const list = (allowlist ?? []).map((e) => e.trim()).filter(Boolean);
  if (list.length === 0) return true;
  if (!ip) return false;
  return list.some((entry) => ipMatches(ip, entry));
}

/** Validate an allowlist entry as typed, for the settings form. */
export function isValidIpEntry(entry: string): boolean {
  const text = entry.trim();
  if (!text) return false;
  const slash = text.indexOf("/");
  if (slash === -1) return toBytes(text) !== null;
  const base = text.slice(0, slash).trim();
  const prefix = Number(text.slice(slash + 1).trim());
  if (!toBytes(base) || !Number.isInteger(prefix) || prefix < 0) return false;
  return prefix <= (v4ToInt(base) !== null ? 32 : 128);
}

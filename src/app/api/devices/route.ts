import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { userDevices, users } from "@/db/schema";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { getDevicePolicy, readDeviceId } from "@/lib/devices";

/**
 * GET /api/devices — the browsers that have signed in.
 *
 * Everyone sees their own. A leader also sees the devices of users under
 * their entities, and the super admin sees all of them, because approving a
 * colleague's new laptop is an admin job — self-approval would make the
 * control decorative.
 */
export async function GET() {
  try {
    const me = await requireUser();

    let visibleUserIds: number[] | null = null; // null = everyone
    if (me.role === "super_admin") {
      visibleUserIds = null;
    } else if (me.role === "company_leader" && me.ownedEntityIds?.length) {
      const staff = await db
        .select({ id: users.user_id })
        .from(users)
        .where(inArray(users.entity_id, me.ownedEntityIds));
      visibleUserIds = Array.from(new Set([me.user_id, ...staff.map((s) => s.id)]));
    } else {
      visibleUserIds = [me.user_id];
    }

    const rows = await db
      .select({
        device_id: userDevices.device_id,
        user_id: userDevices.user_id,
        user_name: users.full_name,
        username: users.username,
        label: userDevices.label,
        user_agent: userDevices.user_agent,
        last_ip: userDevices.last_ip,
        status: userDevices.status,
        first_seen_at: userDevices.first_seen_at,
        last_seen_at: userDevices.last_seen_at,
        fingerprint: userDevices.fingerprint,
      })
      .from(userDevices)
      .innerJoin(users, eq(users.user_id, userDevices.user_id))
      .where(visibleUserIds ? inArray(userDevices.user_id, visibleUserIds) : undefined)
      .orderBy(desc(userDevices.last_seen_at));

    // "This is the one you're on" — so nobody blocks their own browser by
    // mistake, and a new machine is easy to spot in the list.
    const current = await readDeviceId();
    return Response.json({
      policy: await getDevicePolicy(),
      devices: rows.map(({ fingerprint, ...d }) => ({
        ...d,
        is_current: fingerprint === current && d.user_id === me.user_id,
      })),
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { userDevices, users } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity, requestContext } from "@/lib/activity-log";
import { readDeviceId } from "@/lib/devices";

const patchSchema = z.object({
  status: z.enum(["approved", "blocked", "pending"]).optional(),
  label: z.string().min(1).max(80).optional(),
});

/**
 * Who may act on a device: the super admin on any, a leader on their own
 * people's. A user cannot approve their own — the whole point of the list is
 * that a machine nobody vouched for doesn't get in.
 */
async function loadForAdmin(deviceId: number, me: Awaited<ReturnType<typeof requireWriteUser>>) {
  const [row] = await db
    .select({
      device: userDevices,
      owner_entity: users.entity_id,
      owner_name: users.full_name,
    })
    .from(userDevices)
    .innerJoin(users, eq(users.user_id, userDevices.user_id))
    .where(eq(userDevices.device_id, deviceId));
  if (!row) throw new AuthError(404, "No such device");

  if (me.role === "super_admin") return row;
  if (
    me.role === "company_leader" &&
    me.ownedEntityIds?.includes(row.owner_entity) &&
    row.device.user_id !== me.user_id
  ) {
    return row;
  }
  throw new AuthError(403, "Only an administrator can approve or block a device");
}

/** PATCH /api/devices/:id — approve, block, or rename a device. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireWriteUser();
    const deviceId = Number((await params).id);
    if (!Number.isInteger(deviceId)) return jsonError("Bad device id");

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Send a status or a label");
    const patch = parsed.data;

    // Renaming your own device is yours to do; changing its status isn't.
    const current = await readDeviceId();
    const [own] = await db
      .select()
      .from(userDevices)
      .where(eq(userDevices.device_id, deviceId));
    const isMine = own?.user_id === me.user_id;
    if (patch.status === undefined && patch.label && isMine) {
      const [renamed] = await db
        .update(userDevices)
        .set({ label: patch.label })
        .where(eq(userDevices.device_id, deviceId))
        .returning();
      return Response.json({ device: renamed });
    }

    const row = await loadForAdmin(deviceId, me);

    // Blocking the browser you're sitting at signs you out of your own list.
    if (patch.status === "blocked" && row.device.fingerprint === current && isMine) {
      throw new AuthError(400, "That's the device you're using right now");
    }

    const [updated] = await db
      .update(userDevices)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.label ? { label: patch.label } : {}),
        ...(patch.status === "approved"
          ? { approved_by_user_id: me.user_id, approved_at: new Date().toISOString() }
          : {}),
        ...(patch.status && patch.status !== "approved"
          ? { approved_by_user_id: null, approved_at: null }
          : {}),
      })
      .where(eq(userDevices.device_id, deviceId))
      .returning();

    if (patch.status) {
      await logActivity({
        category: "user",
        action: `device.${patch.status}`,
        summary:
          `${me.full_name} ${patch.status === "approved" ? "approved" : patch.status === "blocked" ? "blocked" : "reset"} ` +
          `"${updated.label ?? "a device"}" for ${row.owner_name}`,
        actorUserId: me.user_id,
        actorLabel: me.username,
        targetType: "user",
        targetId: updated.user_id,
        targetLabel: row.owner_name,
        context: { ...requestContext(request), device_id: updated.device_id },
      });
    }

    return Response.json({ device: updated });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/**
 * DELETE /api/devices/:id — forget a device.
 *
 * Its next sign-in comes back as a new pending one, so this is "make it ask
 * again", not "ban it". Your own devices are yours to remove.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireWriteUser();
    const deviceId = Number((await params).id);
    if (!Number.isInteger(deviceId)) return jsonError("Bad device id");

    const [own] = await db
      .select()
      .from(userDevices)
      .where(eq(userDevices.device_id, deviceId));
    if (!own) throw new AuthError(404, "No such device");
    if (own.user_id !== me.user_id) await loadForAdmin(deviceId, me);

    await db.delete(userDevices).where(eq(userDevices.device_id, deviceId));

    await logActivity({
      category: "user",
      action: "device.removed",
      summary: `${me.full_name} removed the device "${own.label ?? "unnamed"}"`,
      actorUserId: me.user_id,
      actorLabel: me.username,
      targetType: "user",
      targetId: own.user_id,
      targetLabel: String(own.user_id),
      context: { ...requestContext(request), device_id: deviceId },
    });

    return Response.json({ removed: true });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

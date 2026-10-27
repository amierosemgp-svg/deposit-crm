import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities } from "@/db/schema";
import { authErrorResponse, requireUser, type AuthedUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import {
  CASINO_EPOCH_KEY,
  KILL_CASINOS_KEY,
  KILL_SWITCH_KEY,
  SESSION_EPOCH_KEY,
  getCasinoEpochs,
  getCasinoKills,
  getKillSwitch,
  setSetting,
  type KillSwitchState,
} from "@/lib/kill-switch";

/**
 * scope "all" is the global switch (admin only); a list of ids is those
 * casinos. Left out, it means "all" for the admin and the caller's own
 * casinos for everyone else — what the Ctrl+Alt+Delete shortcut sends.
 */
const bodySchema = z.object({
  action: z.enum(["activate", "release"]),
  scope: z.union([z.literal("all"), z.array(z.number().int().positive()).min(1)]).optional(),
});

/** The casinos this user may kill or release: their own; every one for the admin. */
async function casinoChoices(user: AuthedUser): Promise<{ id: number; name: string }[]> {
  const where =
    user.role === "super_admin" || user.companyIds === null
      ? eq(entities.entity_type, "company")
      : user.companyIds.length
        ? and(eq(entities.entity_type, "company"), inArray(entities.entity_id, user.companyIds))
        : undefined;
  if (!where) return [];
  const rows = await db
    .select({ id: entities.entity_id, name: entities.name })
    .from(entities)
    .where(where);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** GET /api/kill-switch — the global switch and the casinos this user may throw. */
export async function GET() {
  try {
    // Any signed-in user may read the switch — it's the whole team's brake.
    const user = await requireUser();
    const [global, kills, choices] = await Promise.all([
      getKillSwitch(),
      getCasinoKills(),
      casinoChoices(user),
    ]);
    return Response.json({
      kill_switch: global,
      can_global: user.role === "super_admin",
      casinos: choices.map((c) => ({ ...c, ...(kills[String(c.id)] ?? { active: false }) })),
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/**
 * POST /api/kill-switch — throw or release a casino's switch, or the global one.
 *
 * A casino's switch refuses that casino's bot keys with the wipe order and
 * signs out its CS desk. The global switch does that for every bot and every
 * session, the caller's included, and only the admin may throw it.
 *
 * Anyone signed in may throw their own casino's switch — an emergency stop
 * nobody can reach is not an emergency stop. A leader with several casinos
 * picks which.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Provide action: activate | release, and scope");
    const { action } = parsed.data;
    const nowIso = new Date().toISOString();
    const isAdmin = user.role === "super_admin";
    const scope = parsed.data.scope ?? (isAdmin ? "all" : undefined);

    if (scope === "all") {
      if (!isAdmin) return jsonError("Only the admin can stop every casino at once", 403);
      if (action === "activate") {
        const next: KillSwitchState = { active: true, activated_at: nowIso, activated_by: user.username };
        await setSetting(KILL_SWITCH_KEY, next);
        // One-way bump: every session minted before this instant is dead.
        await setSetting(SESSION_EPOCH_KEY, Date.now());
        await logActivity({
          category: "settings",
          action: "kill_switch.activated",
          summary: `EMERGENCY KILL SWITCH (all casinos) activated by ${user.username} — bot API closed with wipe order, all sessions signed out`,
          actor: user,
        });
        return Response.json({ kill_switch: next, signed_out: true });
      }
      const next: KillSwitchState = {
        ...(await getKillSwitch()),
        active: false,
        released_at: nowIso,
        released_by: user.username,
      };
      await setSetting(KILL_SWITCH_KEY, next);
      await logActivity({
        category: "settings",
        action: "kill_switch.released",
        summary: `Kill switch (all casinos) released by ${user.username} — bot API re-opened`,
        actor: user,
      });
      return Response.json({ kill_switch: next });
    }

    // Casinos: the ones named, or — from the shortcut — the caller's own.
    const choices = await casinoChoices(user);
    const allowed = new Map(choices.map((c) => [c.id, c.name]));
    const ids = scope ?? choices.map((c) => c.id);
    if (!ids.length) return jsonError("You have no casino to stop");
    if (!scope && ids.length > 1) {
      return jsonError("You run several casinos — pick which to stop from the Kill switch button");
    }
    const outside = ids.filter((id) => !allowed.has(id));
    if (outside.length) return jsonError("That casino isn't one of yours", 403);

    const kills = await getCasinoKills();
    const epochs = await getCasinoEpochs();
    for (const id of ids) {
      kills[String(id)] =
        action === "activate"
          ? { active: true, activated_at: nowIso, activated_by: user.username }
          : { ...(kills[String(id)] ?? {}), active: false, released_at: nowIso, released_by: user.username };
      if (action === "activate") epochs[String(id)] = Date.now();
    }
    await setSetting(KILL_CASINOS_KEY, kills);
    if (action === "activate") await setSetting(CASINO_EPOCH_KEY, epochs);

    for (const id of ids) {
      await logActivity({
        category: "settings",
        action: action === "activate" ? "kill_switch.casino_activated" : "kill_switch.casino_released",
        summary:
          action === "activate"
            ? `KILL SWITCH for ${allowed.get(id)} activated by ${user.username} — its bots get the wipe order, its CS are signed out`
            : `Kill switch for ${allowed.get(id)} released by ${user.username} — its bots may reconnect`,
        actor: user,
        companyEntityId: id,
      });
    }

    return Response.json({
      casinos: ids.map((id) => ({ id, name: allowed.get(id), ...kills[String(id)] })),
      // A CS who stopped their own casino is among those signed out.
      signed_out: action === "activate" && user.role === "cs_agent",
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

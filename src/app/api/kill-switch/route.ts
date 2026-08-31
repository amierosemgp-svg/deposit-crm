import { z } from "zod";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import {
  KILL_SWITCH_KEY,
  SESSION_EPOCH_KEY,
  getKillSwitch,
  setSetting,
  type KillSwitchState,
} from "@/lib/kill-switch";

const bodySchema = z.object({ action: z.enum(["activate", "release"]) });

/** GET /api/kill-switch — current state (admins only). */
export async function GET() {
  try {
    // Any signed-in user may read the switch — it's the whole team's brake.
    await requireUser();
    return Response.json({ kill_switch: await getKillSwitch() });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/**
 * POST /api/kill-switch — throw or release the emergency switch.
 *
 * Activation is deliberately loud and total: bots are cut off with a wipe
 * order, and EVERY session (this admin's included) is invalidated. The caller
 * should expect its next request to come back 401.
 */
export async function POST(request: Request) {
  try {
    // Any signed-in user can throw or release it — an emergency stop nobody
    // can reach is not an emergency stop.
    const user = await requireUser();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Provide action: activate | release");
    const nowIso = new Date().toISOString();
    const current = await getKillSwitch();

    if (parsed.data.action === "activate") {
      const next: KillSwitchState = {
        active: true,
        activated_at: nowIso,
        activated_by: user.username,
      };
      await setSetting(KILL_SWITCH_KEY, next);
      // One-way bump: every session minted before this instant is dead.
      await setSetting(SESSION_EPOCH_KEY, Date.now());
      await logActivity({
        category: "settings",
        action: "kill_switch.activated",
        summary: `EMERGENCY KILL SWITCH activated by ${user.username} — bot API closed with wipe order, all sessions signed out`,
        actor: user,
      });
      return Response.json({ kill_switch: next });
    }

    const next: KillSwitchState = {
      ...current,
      active: false,
      released_at: nowIso,
      released_by: user.username,
    };
    await setSetting(KILL_SWITCH_KEY, next);
    await logActivity({
      category: "settings",
      action: "kill_switch.released",
      summary: `Kill switch released by ${user.username} — bot API re-opened`,
      actor: user,
    });
    return Response.json({ kill_switch: next });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";

/**
 * Emergency kill switch — the operator's own panic button.
 *
 * When active:
 *  - every /api/bot/* request is refused with 410 and a wipe instruction, so
 *    each agent learns on its next poll to stop, clear its local credentials/
 *    config/data, close its browser and not reconnect (agents poll; the CRM
 *    cannot push, so "on next poll" is as immediate as it gets);
 *  - every CRM session issued before the switch was thrown is invalid
 *    (session_epoch), so all humans are signed out and must log in again.
 *
 * Releasing the switch re-opens the bot API. Sessions stay invalidated —
 * epoch bumps are one-way; people just sign in again.
 */

export const KILL_SWITCH_KEY = "kill_switch";
export const SESSION_EPOCH_KEY = "session_epoch";

export type KillSwitchState = {
  active: boolean;
  activated_at?: string;
  activated_by?: string;
  released_at?: string;
  released_by?: string;
};

export async function getKillSwitch(): Promise<KillSwitchState> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, KILL_SWITCH_KEY));
  return (row?.value as KillSwitchState | undefined) ?? { active: false };
}

/** Sessions minted before this instant (ms epoch) are dead. 0 = never bumped. */
export async function getSessionEpoch(): Promise<number> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, SESSION_EPOCH_KEY));
  return typeof row?.value === "number" ? row.value : 0;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updated_at: sql`now()` },
    });
}

/** The body every gated bot request receives — the agent's wipe order. */
export const KILL_RESPONSE_BODY = {
  error: "Emergency kill switch is active",
  kill_switch: true,
  instructions: [
    "stop_all_work",
    "wipe_local_credentials",
    "wipe_local_config_and_data",
    "clear_browser_cache_cookies",
    "close_all_browser_windows",
    "log_out_everywhere",
    "do_not_reconnect",
  ],
} as const;

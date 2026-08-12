import { z } from "zod";
import { db } from "@/db";
import { botHealth } from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import { jsonError } from "@/lib/bot-crud";

const schema = z.object({
  bot_id: z.string().min(1).max(80),
  state: z.enum([
    "starting",
    "working",
    "idle",
    "stuck",
    "error",
    "maintenance",
    "stopped",
  ]),
  step: z.string().max(120).nullish(),
  error: z.string().nullish(),
  cycle: z.number().int().nullish(),
  last_transaction_at: z.string().nullish(),
  ts: z.string().nullish(),
});

/**
 * POST /api/bot/heartbeat — a bot process reports its health (~every 30s).
 * Upsert by bot_id, newest heartbeat wins; first_seen is set once on insert.
 *
 * `last_heartbeat_at` is **when we received the ping**, not the `ts` the agent
 * reports. Liveness is about arrival, and an agent's own clock can't be trusted:
 * the kiosk fleet was sending local Malaysia time with no offset, so every
 * heartbeat landed 8 hours in the future and those agents would have shown
 * "online" for 8 hours after dying — hiding exactly the outage this page
 * exists to reveal. `ts` is still accepted and echoed back as `reported_ts`
 * so a skewed clock is visible rather than silently trusted.
 */
export async function POST(request: Request) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
  }
  const b = parsed.data;
  const nowIso = new Date().toISOString();
  // Arrival time, always — see the note above.
  const lastHeartbeat = nowIso;

  // Surface a badly skewed agent clock instead of letting it pass unnoticed.
  const reportedMs = b.ts ? Date.parse(b.ts) : NaN;
  const skewSeconds = Number.isFinite(reportedMs)
    ? Math.round((reportedMs - Date.now()) / 1000)
    : null;

  await db
    .insert(botHealth)
    .values({
      bot_id: b.bot_id,
      state: b.state,
      step: b.step ?? null,
      error: b.error ?? null,
      cycle: b.cycle ?? null,
      last_transaction_at: b.last_transaction_at ?? null,
      last_heartbeat_at: lastHeartbeat,
      first_seen: nowIso,
      updated_at: nowIso,
    })
    .onConflictDoUpdate({
      target: botHealth.bot_id,
      set: {
        state: b.state,
        step: b.step ?? null,
        error: b.error ?? null,
        cycle: b.cycle ?? null,
        last_transaction_at: b.last_transaction_at ?? null,
        last_heartbeat_at: lastHeartbeat,
        updated_at: nowIso,
        // first_seen intentionally not updated — preserves the original.
      },
    });

  return Response.json({
    ok: true,
    last_heartbeat_at: lastHeartbeat,
    reported_ts: b.ts ?? null,
    // Positive = your clock is ahead of ours. More than a minute or two
    // usually means a timestamp sent without a timezone offset.
    clock_skew_seconds: skewSeconds,
  });
}

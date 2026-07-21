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
 * `last_heartbeat_at` is the reported `ts` (or server now if omitted).
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
  const lastHeartbeat = b.ts ?? nowIso;

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

  return Response.json({ ok: true });
}

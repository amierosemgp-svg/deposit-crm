import { retryStuckGameTransfers } from "@/lib/api-helpers";

/**
 * GET /api/cron/retry-stuck-transfers — Vercel Cron target (see vercel.json).
 * Restarts game transfers the bot never reported back on, and fails the ones
 * that have exhausted their attempts.
 *
 * Also runs lazily on every /api/state read, so this is the safety net for when
 * nobody has the CRM open.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (header !== `Bearer ${secret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  const { restarted, failed } = await retryStuckGameTransfers();
  return Response.json({ ok: true, restarted, failed });
}

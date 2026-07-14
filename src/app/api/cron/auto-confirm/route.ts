import { autoConfirmExpiredTransfers } from "@/lib/api-helpers";

/**
 * GET /api/cron/auto-confirm — Vercel Cron target (see vercel.json).
 * Settles transfers whose confirmation window has expired.
 * Also runs lazily on every /api/state read, so this is a safety net.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (header !== `Bearer ${secret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  const settled = await autoConfirmExpiredTransfers();
  return Response.json({ ok: true, settled });
}

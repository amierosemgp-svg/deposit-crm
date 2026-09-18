import { sql } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * GET /api/players/activity — when each member last deposited.
 *
 * Deliberately not part of the player roster in /api/state. That payload is
 * 1.5 MB and cached against players.updated_at, which a deposit does not touch
 * until it completes — a "days since last deposit" folded in there would sit
 * frozen for as long as nothing else edited the member. Here it is a few
 * hundred bytes fetched on the page that shows it.
 *
 * Scoped like the roster: a leader sees the companies they currently run.
 */
export async function GET() {
  try {
    const user = await requireUser();

    const scope =
      user.companyIds === null
        ? sql`true`
        : user.companyIds.length
          ? sql`p.company_entity_id IN (${sql.join(
              user.companyIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql`false`;

    // Any deposit that did not fail counts as activity: the member turned up
    // and paid, whether or not CS has finished processing it.
    const res = await db.execute(sql`
      SELECT d.player_id,
             max(d.deposit_date) AS last_deposit_at
        FROM deposits d
        JOIN players p ON p.player_id = d.player_id
       WHERE d.status <> 'failed' AND ${scope}
       GROUP BY 1`);

    return Response.json({ activity: res.rows });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

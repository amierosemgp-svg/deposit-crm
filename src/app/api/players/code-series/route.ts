import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * GET /api/players/code-series?company=30 — the member-code series in use, and
 * the next number each would issue.
 *
 * The Players sheet and the Create player form both number a new member from
 * the prefix they are given: type "GA", get GA2354. That was worked out in the
 * browser by scanning every member — fine at a few hundred, absurd at twelve
 * thousand, and the reason the roster was being shipped at all. It is one
 * grouped query here.
 *
 * Width is the widest the series has used, so a house that numbers G0001 keeps
 * four digits and one that numbers G1 keeps one. A prefix nobody has used yet
 * is absent from the reply; the caller starts it at 1, padded to four.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sp = new URL(request.url).searchParams;

    const where: SQL[] = [];
    if (user.companyIds !== null) {
      where.push(
        user.companyIds.length
          ? sql`company_entity_id IN (${sql.join(
              user.companyIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql`false`,
      );
    }
    const companyParam = sp.get("company");
    if (companyParam && companyParam !== "all") {
      const companyId = Number(companyParam);
      if (!Number.isFinite(companyId)) return jsonError("Bad company");
      where.push(sql`company_entity_id = ${companyId}`);
    }
    // Only codes shaped letters-then-digits carry a series; anything else is
    // a one-off the house typed and has no "next".
    where.push(sql`username ~ '^[A-Za-z]+[0-9]+$'`);

    const rows = await db.execute(sql`
      SELECT upper((regexp_match(username, '^([A-Za-z]+)'))[1])        AS prefix,
             max((regexp_match(username, '([0-9]+)$'))[1]::bigint) + 1 AS next,
             max(length((regexp_match(username, '([0-9]+)$'))[1]))     AS width,
             count(*)::int                                             AS members
        FROM players
       WHERE ${sql.join(where, sql` AND `)}
       GROUP BY 1
       ORDER BY 2 DESC`);

    return Response.json({
      series: (rows.rows as unknown as {
        prefix: string;
        next: string | number;
        width: number;
        members: number;
      }[]).map((r) => ({
        prefix: r.prefix,
        next: Number(r.next),
        width: Number(r.width),
        members: r.members,
      })),
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

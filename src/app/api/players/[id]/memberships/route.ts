import { eq } from "drizzle-orm";
import { db } from "@/db";
import { entities, people, players } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

/**
 * GET /api/players/:id/memberships — every company this player's PERSON appears
 * under. Answers "how many companies is this person a member of, and their code
 * + totals at each" — the leader's cross-company view.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const memberId = Number((await params).id);

    const [self] = await db.select().from(players).where(eq(players.player_id, memberId));
    if (!self) return jsonError("Player not found", 404);
    if (
      user.companyIds !== null &&
      !user.companyIds.includes(self.company_entity_id)
    ) {
      throw new AuthError(403, "Player is outside your scope");
    }
    if (!self.person_id) {
      return Response.json({ person: null, memberships: [] });
    }

    const [person] = await db.select().from(people).where(eq(people.person_id, self.person_id));
    const siblings = await db
      .select({
        member_id: players.player_id,
        company_entity_id: players.company_entity_id,
        member_code: players.username,
        status: players.status,
        total_deposits: players.total_deposits,
        total_withdrawals: players.total_withdrawals,
        registration_date: players.registration_date,
      })
      .from(players)
      .where(eq(players.person_id, self.person_id));

    const ents = await db.select({ id: entities.entity_id, name: entities.name }).from(entities);
    const nameById = new Map(ents.map((e) => [e.id, e.name]));

    // A leader/admin sees every membership; a company-scoped user only their own.
    const visible = siblings.filter(
      (m) => user.companyIds === null || user.companyIds.includes(m.company_entity_id),
    );

    return Response.json({
      person: person
        ? { person_id: person.person_id, full_name: person.full_name, contact_number: person.contact_number, needs_review: person.needs_review }
        : null,
      // How many companies in total (even those this user can't open), so the
      // count is honest even when the list is filtered.
      total_companies: siblings.length,
      memberships: visible
        .map((m) => ({
          ...m,
          company: nameById.get(m.company_entity_id) ?? "—",
          is_current: m.member_id === memberId,
        }))
        .sort((a, b) => a.company.localeCompare(b.company)),
    });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

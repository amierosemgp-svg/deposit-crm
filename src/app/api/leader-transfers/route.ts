import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { entities, leaderTransfers, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";

const createSchema = z.object({
  from_leader_entity_id: z.number().int().positive(),
  to_leader_entity_id: z.number().int().positive(),
  amount: z.number().positive(),
  note: z.string().max(300).optional(),
});

/**
 * GET /api/leader-transfers — the settlement ledger between leaders.
 * Super-admin only: leaders sit at the top of the tree, and only the main
 * company sees across all of them.
 */
export async function GET() {
  try {
    const user = await requireUser();
    if (user.role !== "super_admin") throw new AuthError(403, "Admins only");
    const rows = await db
      .select()
      .from(leaderTransfers)
      .orderBy(desc(leaderTransfers.created_at))
      .limit(2000);
    return Response.json({ leader_transfers: rows });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/** POST /api/leader-transfers — record a transfer from one leader to another. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (user.role !== "super_admin") throw new AuthError(403, "Admins only");
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    if (body.from_leader_entity_id === body.to_leader_entity_id) {
      return jsonError("From and to leader must differ");
    }

    // Both ends must be actual leader entities.
    const ends = await db
      .select({ id: entities.entity_id, type: entities.entity_type, name: entities.name })
      .from(entities);
    const byId = new Map(ends.map((e) => [e.id, e]));
    const from = byId.get(body.from_leader_entity_id);
    const to = byId.get(body.to_leader_entity_id);
    if (!from || from.type !== "leader") return jsonError("From is not a leader");
    if (!to || to.type !== "leader") return jsonError("To is not a leader");

    const created = await db.transaction(async (txn) => {
      const [row] = await txn
        .insert(leaderTransfers)
        .values({
          from_leader_entity_id: body.from_leader_entity_id,
          to_leader_entity_id: body.to_leader_entity_id,
          amount: body.amount,
          note: body.note ?? null,
          created_by_user_id: user.user_id,
        })
        .returning();

      // One audit row for the unified history + the transaction filter. Kept as
      // its own type (never "expense"), scoped to the sending leader.
      await txn.insert(transactions).values({
        entity_id: body.from_leader_entity_id,
        type: "leader_transfer",
        amount: body.amount,
        reference_id: row.transfer_id,
        user_id: user.user_id,
        details: {
          from_leader_entity_id: body.from_leader_entity_id,
          from_leader: from.name,
          to_leader_entity_id: body.to_leader_entity_id,
          to_leader: to.name,
          note: body.note ?? null,
        },
      });

      return row;
    });

    await logActivity({
      category: "entity",
      action: "leader_transfer.created",
      summary: `Leader transfer: ${from.name} → ${to.name}, RM ${body.amount.toFixed(2)}`,
      actor: user,
      targetType: "leader_transfer",
      targetId: created.transfer_id,
      context: { amount: body.amount, note: body.note ?? null },
    });

    return Response.json({ leader_transfer: created }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

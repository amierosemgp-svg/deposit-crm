import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { deposits, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { inCasinoScope } from "@/lib/salary";

/**
 * GET /api/staff-penalties/source?type=deposit|free_credit&id=N — fill a new
 * penalty from the row the mistake was made on: who handled it, what was
 * credited (deposit plus bonus — the player could spend both), the player.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sp = new URL(request.url).searchParams;
    const type = sp.get("type");
    const id = Number(sp.get("id"));
    if (!id) return jsonError("id required");

    if (type === "deposit") {
      const [row] = await db
        .select({ d: deposits, p: players })
        .from(deposits)
        .leftJoin(players, eq(players.player_id, deposits.player_id))
        .where(eq(deposits.deposit_id, id));
      if (!row) return jsonError(`No deposit #${id}`, 404);
      if (row.p && !inCasinoScope(user, row.p.company_entity_id)) {
        throw new AuthError(403, "That deposit is outside your organisation");
      }
      return Response.json({
        source: {
          user_id: row.d.handled_by_user_id ?? row.d.assigned_to_user_id ?? null,
          credit_injected: row.d.total_amount || row.d.deposit_amount,
          player_id: row.d.player_id,
          player_label: row.p ? `${row.p.username} · ${row.p.full_name}` : null,
          occurred_at: row.d.approved_at ?? row.d.deposit_date,
          status: row.d.status,
        },
      });
    }
    if (type === "free_credit") {
      const [row] = await db
        .select({ t: transactions, p: players })
        .from(transactions)
        .leftJoin(players, eq(players.player_id, transactions.player_id))
        .where(and(eq(transactions.transaction_id, id), eq(transactions.type, "game_topup")));
      if (!row) return jsonError(`No free credit #${id}`, 404);
      if (row.p && !inCasinoScope(user, row.p.company_entity_id)) {
        throw new AuthError(403, "That free credit is outside your organisation");
      }
      return Response.json({
        source: {
          user_id: row.t.user_id,
          credit_injected: row.t.amount,
          player_id: row.t.player_id,
          player_label: row.p ? `${row.p.username} · ${row.p.full_name}` : null,
          occurred_at: row.t.created_at,
          status: null,
        },
      });
    }
    return jsonError("Only a deposit or a free credit can be looked up");
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

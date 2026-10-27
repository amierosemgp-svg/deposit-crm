import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, players, salaryAdjustments, staffPenalties, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { getSettingNumber, jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { csCasino, inCasinoScope, penaltyFigures, STAFF_PENALTY_SHARE_KEY } from "@/lib/salary";

const createSchema = z
  .object({
    user_id: z.number().int().positive(),
    source_type: z.enum(["deposit", "free_credit", "game_transfer", "withdrawal", "other"]),
    source_id: z.number().int().positive().nullable().optional(),
    player_id: z.number().int().positive().nullable().optional(),
    occurred_at: z.string().min(1),
    credit_injected: z.number().positive(),
    credit_retrieved: z.number().min(0),
    // Omitted = the house share from settings.
    share_pct: z.number().min(0).max(100).optional(),
    reason: z.string().trim().min(1).max(200),
    notes: z.string().max(1000).optional(),
  })
  .refine((v) => v.credit_retrieved < v.credit_injected, {
    message: "Retrieved has to be less than what was credited — otherwise nothing was lost",
    path: ["credit_retrieved"],
  });

/**
 * POST /api/staff-penalties — a CS's share of credit the house lost through
 * their mistake. Writes the pending deduction their next salary will take,
 * and books the whole loss (credited − retrieved, not just the CS's share) as
 * a Staff Error bonus: the player kept that credit, so the house gave it away.
 *
 * Any desk user can record one; voiding is a leader's or the admin's call.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    const body = parsed.data;

    if (body.user_id === user.user_id && user.role === "cs_agent") {
      // Owning up is fine; it still goes through someone else's hands.
      throw new AuthError(403, "Ask a colleague or your leader to record a penalty against you");
    }
    const cs = await csCasino(db, body.user_id);
    if (!cs) return jsonError("Penalties are for CS agents — pick one");
    if (!inCasinoScope(user, cs.casinoId)) throw new AuthError(403, "That CS is outside your organisation");
    if (Number.isNaN(new Date(body.occurred_at).getTime())) return jsonError("Bad date");

    if (body.player_id != null) {
      const [player] = await db.select().from(players).where(eq(players.player_id, body.player_id));
      if (!player) return jsonError("Player not found", 404);
      if (!inCasinoScope(user, player.company_entity_id)) throw new AuthError(403, "That player is outside your organisation");
    }

    const share = body.share_pct ?? (await getSettingNumber(STAFF_PENALTY_SHARE_KEY, 50));
    const { loss, amount } = penaltyFigures(body.credit_injected, body.credit_retrieved, share);
    if (amount <= 0) return jsonError("That works out to RM 0 — nothing to deduct");

    const penalty = await db.transaction(async (txn) => {
      const [row] = await txn
        .insert(staffPenalties)
        .values({
          user_id: body.user_id,
          company_entity_id: cs.casinoId,
          source_type: body.source_type,
          source_id: body.source_id ?? null,
          player_id: body.player_id ?? null,
          occurred_at: new Date(body.occurred_at).toISOString(),
          credit_injected: body.credit_injected,
          credit_retrieved: body.credit_retrieved,
          loss_amount: loss,
          share_pct: share,
          amount,
          reason: body.reason,
          notes: body.notes?.trim() || null,
          recorded_by_user_id: user.user_id,
        })
        .returning();
      await txn.insert(salaryAdjustments).values({
        user_id: row.user_id,
        company_entity_id: row.company_entity_id,
        kind: "penalty",
        amount: -row.amount,
        reason: row.reason,
        occurred_at: row.occurred_at,
        penalty_id: row.penalty_id,
        created_by_user_id: user.user_id,
      });
      // Ledger only — the credit is already in the player's game, so no
      // balance or BO pool moves. Dated when the mistake happened, so it lands
      // in that month's bonus figures and that month's free-credit allowance.
      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: row.company_entity_id,
        type: "game_topup",
        amount: row.loss_amount,
        game_name: await sourceGame(txn, row.source_type, row.source_id),
        reference_id: row.penalty_id,
        user_id: user.user_id,
        details: {
          action: "staff_error",
          penalty_id: row.penalty_id,
          cs_user_id: row.user_id,
          source_type: row.source_type,
          source_id: row.source_id,
          credit_injected: row.credit_injected,
          credit_retrieved: row.credit_retrieved,
          reason: row.reason,
        },
        created_at: row.occurred_at,
      });
      return row;
    });

    await logActivity({
      category: "payroll",
      action: "staff_penalty.created",
      summary:
        `Staff penalty: ${cs.user.full_name} — RM ${penalty.amount.toFixed(2)} ` +
        `(${penalty.share_pct}% of RM ${penalty.loss_amount.toFixed(2)} lost: ` +
        `${penalty.credit_injected.toFixed(2)} credited, ${penalty.credit_retrieved.toFixed(2)} retrieved) — ${penalty.reason}`,
      actor: user,
      companyEntityId: penalty.company_entity_id,
      targetType: "staff_penalty",
      targetId: penalty.penalty_id,
      targetLabel: cs.user.username,
      context: { source_type: penalty.source_type, source_id: penalty.source_id },
    });
    return Response.json({ penalty }, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The game the mistaken credit went into, when the source row says. */
async function sourceGame(
  txn: Tx,
  type: (typeof staffPenalties.$inferSelect)["source_type"],
  id: number | null,
): Promise<string | null> {
  if (id == null) return null;
  if (type === "deposit") {
    const [d] = await txn
      .select({ game: deposits.selected_game })
      .from(deposits)
      .where(eq(deposits.deposit_id, id));
    return d?.game || null;
  }
  if (type === "free_credit") {
    const [t] = await txn
      .select({ game: transactions.game_name })
      .from(transactions)
      .where(and(eq(transactions.transaction_id, id), eq(transactions.type, "game_topup")));
    return t?.game || null;
  }
  return null;
}

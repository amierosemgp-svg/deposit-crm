import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { deposits, players, salaryAdjustments, staffPenalties, transactions, users, withdrawals } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { canManagePay, csCasino, inCasinoScope, penaltyFigures } from "@/lib/salary";
import { undoStaffErrorOnDeposit, type StaffErrorDepositEffect } from "@/lib/staff-error";
import { canonicalise } from "@/lib/game-name";
import { InsufficientBankBalanceError } from "@/lib/bank-balance";
import { InsufficientKioskCreditError, moveKioskCredit } from "@/lib/kiosk-credit";

class Refusal extends Error {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const editSchema = z
  .object({
    user_id: z.number().int().positive(),
    occurred_at: z.string().min(1),
    credit_injected: z.number().positive(),
    credit_retrieved: z.number().min(0),
    share_pct: z.number().min(0).max(100),
    reason: z.string().trim().min(1).max(200),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });

/**
 * PATCH /api/staff-penalties/:id — correct a saved penalty: who, when, the
 * figures, what happened. Which row it was made on stays; a wrong Ref is a
 * void and a new one.
 *
 * Same rule as voiding: only while pending — a salary that took it froze it.
 * Everything the penalty wrote follows the change: the salary deduction (moved
 * to the new CS, or dropped for a leader), the Staff Error bonus row, and on a
 * failed deposit the kiosk correction, which moves by the change in the loss.
 * Same people as recording one: any desk user, never a CS on themselves.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireWriteUser();
    const id = Number((await params).id);
    const parsed = editSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload: " + parsed.error.issues[0]?.message);
    const body = parsed.data;
    if (body.occurred_at !== undefined && Number.isNaN(new Date(body.occurred_at).getTime())) {
      return jsonError("Bad date");
    }

    const { before, after, person, leader } = await db.transaction(async (txn) => {
      const [row] = await txn.select().from(staffPenalties).where(eq(staffPenalties.penalty_id, id)).for("update");
      if (!row) throw new AuthError(404, "Penalty not found");
      if (!inCasinoScope(user, row.company_entity_id)) throw new AuthError(403, "That penalty is outside your organisation");
      if (row.status === "void") throw new Refusal("It's void — record a new one");
      const [adj] = await txn
        .select()
        .from(salaryAdjustments)
        .where(eq(salaryAdjustments.penalty_id, row.penalty_id))
        .for("update");
      if (adj?.salary_id != null) throw new Refusal("Already deducted from a salary — reverse that salary first");

      const userId = body.user_id ?? row.user_id;
      if (user.role === "cs_agent" && (userId === user.user_id || row.user_id === user.user_id)) {
        throw new AuthError(403, "Ask a colleague or your leader to change a penalty against you");
      }
      const cs = await csCasino(txn, userId);
      const leader = cs ? null : await activeLeader(txn, userId);
      if (!cs && !leader) throw new Refusal("Penalties are for CS agents and leaders — pick one");
      const casinoId = cs ? cs.casinoId : await sourceCasino(txn, row);
      if (casinoId === null) throw new Refusal("A leader's penalty needs the row it was made on — give the Ref or the player");
      if (!inCasinoScope(user, casinoId)) throw new AuthError(403, "That casino is outside your organisation");

      const injected = body.credit_injected ?? row.credit_injected;
      const retrieved = body.credit_retrieved ?? row.credit_retrieved;
      const share = body.share_pct ?? row.share_pct;
      if (retrieved >= injected) throw new Refusal("Retrieved has to be less than what was credited — otherwise nothing was lost");
      const { loss, amount } = penaltyFigures(injected, retrieved, share);
      if (amount <= 0) throw new Refusal("That works out to RM 0 — nothing to deduct");
      const occurredAt = body.occurred_at !== undefined ? new Date(body.occurred_at).toISOString() : row.occurred_at;
      const reason = body.reason ?? row.reason;

      const [updated] = await txn
        .update(staffPenalties)
        .set({
          user_id: userId,
          company_entity_id: casinoId,
          occurred_at: occurredAt,
          credit_injected: injected,
          credit_retrieved: retrieved,
          loss_amount: loss,
          share_pct: share,
          amount,
          reason,
        })
        .where(eq(staffPenalties.penalty_id, row.penalty_id))
        .returning();

      // The deduction: a CS's next salary takes it; a leader has none.
      const deduction = { user_id: userId, company_entity_id: casinoId, amount: -amount, reason, occurred_at: occurredAt };
      if (cs && adj) await txn.update(salaryAdjustments).set(deduction).where(eq(salaryAdjustments.adjustment_id, adj.adjustment_id));
      else if (cs) {
        await txn.insert(salaryAdjustments).values({
          ...deduction,
          kind: "penalty",
          penalty_id: row.penalty_id,
          created_by_user_id: user.user_id,
        });
      } else if (adj) await txn.delete(salaryAdjustments).where(eq(salaryAdjustments.adjustment_id, adj.adjustment_id));

      // The Staff Error bonus row carries the loss, and on a deposit what the
      // penalty did to the kiosk — which moves by however much the loss did.
      const isStaffError = and(
        eq(transactions.type, "game_topup"),
        sql`${transactions.details}->>'action' = 'staff_error'`,
        sql`(${transactions.details}->>'penalty_id')::int = ${row.penalty_id}`,
      );
      const [booked] = await txn
        .select({ transaction_id: transactions.transaction_id, details: transactions.details })
        .from(transactions)
        .where(isStaffError);
      if (booked) {
        const details = { ...(booked.details as Record<string, unknown>) };
        const correction = Number((details as Partial<StaffErrorDepositEffect>).kiosk_correction ?? 0);
        if (row.source_type === "deposit" && row.source_id != null && correction !== 0 && loss !== row.loss_amount) {
          const [dep] = await txn.select().from(deposits).where(eq(deposits.deposit_id, row.source_id));
          if (dep) {
            const game = dep.selected_game ? await canonicalise(dep.selected_game, txn) : null;
            await moveKioskCredit(txn, {
              companyEntityId: dep.company_entity_id,
              gameName: game,
              delta: -(loss - row.loss_amount),
            });
            details.kiosk_correction = -loss;
          }
        }
        Object.assign(details, { cs_user_id: userId, credit_injected: injected, credit_retrieved: retrieved, reason });
        await txn
          .update(transactions)
          .set({ amount: loss, entity_id: casinoId, created_at: occurredAt, details })
          .where(eq(transactions.transaction_id, booked.transaction_id));
      }

      return { before: row, after: updated, person: cs?.user ?? leader!, leader };
    });

    const changes = (
      [
        ["CS / Leader", before.user_id, after.user_id],
        ["date", before.occurred_at.slice(0, 10), after.occurred_at.slice(0, 10)],
        ["credited", before.credit_injected, after.credit_injected],
        ["retrieved", before.credit_retrieved, after.credit_retrieved],
        ["share", `${before.share_pct}%`, `${after.share_pct}%`],
        ["what happened", before.reason, after.reason],
      ] as Array<[string, unknown, unknown]>
    )
      .filter(([, a, b]) => a !== b)
      .map(([k, a, b]) => `${k} ${a} → ${b}`);
    await logActivity({
      category: "payroll",
      action: "staff_penalty.edited",
      summary:
        `Staff penalty edited: ${person.full_name}${leader ? " (leader)" : ""} — RM ${after.amount.toFixed(2)}` +
        (changes.length ? ` (${changes.join("; ")})` : ""),
      actor: user,
      companyEntityId: after.company_entity_id,
      targetType: "staff_penalty",
      targetId: after.penalty_id,
      targetLabel: person.username,
      context: { before, after },
    });
    return Response.json({ penalty: after });
  } catch (e) {
    if (e instanceof Refusal) return jsonError(e.message, 422);
    if (e instanceof InsufficientKioskCreditError) return jsonError(e.message, 422);
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/** An active company leader, or null. */
async function activeLeader(q: Tx, userId: number) {
  const [u] = await q.select().from(users).where(eq(users.user_id, userId));
  return u && u.role === "company_leader" && u.status === "active" ? u : null;
}

/** The casino of the row the mistake was made on — where a leader's penalty is filed. */
async function sourceCasino(q: Tx, row: typeof staffPenalties.$inferSelect): Promise<number | null> {
  let casino: number | null = null;
  if (row.player_id != null) {
    const [p] = await q.select({ c: players.company_entity_id }).from(players).where(eq(players.player_id, row.player_id));
    casino = p?.c ?? null;
  }
  if (row.source_id == null) return casino;
  if (row.source_type === "deposit") {
    const [d] = await q.select({ c: deposits.company_entity_id }).from(deposits).where(eq(deposits.deposit_id, row.source_id));
    return d?.c ?? casino;
  }
  if (row.source_type === "free_credit") {
    const [t] = await q.select({ c: transactions.entity_id }).from(transactions).where(eq(transactions.transaction_id, row.source_id));
    return t?.c ?? casino;
  }
  if (row.source_type === "withdrawal") {
    const [w] = await q
      .select({ c: players.company_entity_id })
      .from(withdrawals)
      .innerJoin(players, eq(players.player_id, withdrawals.player_id))
      .where(eq(withdrawals.withdrawal_id, row.source_id));
    return w?.c ?? casino;
  }
  return casino;
}

/**
 * DELETE /api/staff-penalties/:id — void a penalty recorded in error.
 *
 * Only while it is still pending: once a salary has deducted it, reversing
 * that salary is what puts it back in play. A deposit the penalty failed is
 * completed again, and the kiosk gets back what the penalty took off it.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireWriteUser();
    if (!canManagePay(user.role)) throw new AuthError(403, "Only a leader or the admin can void a penalty");
    const id = Number((await params).id);

    const penalty = await db.transaction(async (txn) => {
      const [row] = await txn.select().from(staffPenalties).where(eq(staffPenalties.penalty_id, id)).for("update");
      if (!row) throw new AuthError(404, "Penalty not found");
      if (!inCasinoScope(user, row.company_entity_id)) throw new AuthError(403, "That penalty is outside your organisation");
      if (row.status === "void") throw new Refusal("Already void");
      const [adj] = await txn
        .select()
        .from(salaryAdjustments)
        .where(eq(salaryAdjustments.penalty_id, row.penalty_id))
        .for("update");
      if (adj?.salary_id != null) {
        throw new Refusal("Already deducted from a salary — reverse that salary first");
      }
      if (adj) await txn.delete(salaryAdjustments).where(eq(salaryAdjustments.adjustment_id, adj.adjustment_id));
      // Its Staff Error bonus goes with it: a void penalty lost nothing.
      const isStaffError = and(
        eq(transactions.type, "game_topup"),
        sql`${transactions.details}->>'action' = 'staff_error'`,
        sql`(${transactions.details}->>'penalty_id')::int = ${row.penalty_id}`,
      );
      const [booked] = await txn.select({ details: transactions.details }).from(transactions).where(isStaffError);
      const effect = booked?.details as Partial<StaffErrorDepositEffect> | undefined;
      if (row.source_type === "deposit" && row.source_id != null && effect?.deposit_failed !== undefined) {
        await undoStaffErrorOnDeposit(txn, {
          depositId: row.source_id,
          effect: { deposit_failed: !!effect.deposit_failed, kiosk_correction: effect.kiosk_correction ?? 0 },
          userId: user.user_id,
          nowIso: new Date().toISOString(),
        });
      }
      await txn.delete(transactions).where(isStaffError);
      const [updated] = await txn
        .update(staffPenalties)
        .set({ status: "void", voided_at: new Date().toISOString(), voided_by_user_id: user.user_id })
        .where(eq(staffPenalties.penalty_id, row.penalty_id))
        .returning();
      return updated;
    });

    const [staff] = await db.select().from(users).where(eq(users.user_id, penalty.user_id));
    await logActivity({
      category: "payroll",
      action: "staff_penalty.voided",
      summary: `Staff penalty voided: ${staff?.full_name ?? penalty.user_id} — RM ${penalty.amount.toFixed(2)} (${penalty.reason})`,
      actor: user,
      companyEntityId: penalty.company_entity_id,
      targetType: "staff_penalty",
      targetId: penalty.penalty_id,
      targetLabel: staff?.username ?? null,
    });
    return Response.json({ penalty });
  } catch (e) {
    if (e instanceof Refusal) return jsonError(e.message, 422);
    if (e instanceof InsufficientKioskCreditError) return jsonError(e.message, 422);
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

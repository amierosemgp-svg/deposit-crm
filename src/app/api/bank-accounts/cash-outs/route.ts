import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, bankCashOuts, entities, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";

const createSchema = z.object({
  account_id: z.number().int().positive(),
  amount: z.number().positive().max(10_000_000),
  // The leader entity that took the cash, when it's one of ours.
  taken_by_entity_id: z.number().int().positive().nullable().optional(),
  // Always a name — the leader's is filled in from the entity when omitted.
  taken_by: z.string().trim().max(120).optional(),
  // When the cash left the bank. Defaults to now.
  occurred_at: z.string().optional(),
  notes: z.string().trim().max(500).optional(),
});

/**
 * GET /api/bank-accounts/cash-outs?account_id= — cash taken out of company
 * accounts by hand, newest first, scoped to the caller's companies.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const accountId = Number(url.searchParams.get("account_id"));
    const conds = [];
    if (Number.isInteger(accountId) && accountId > 0) {
      conds.push(eq(bankCashOuts.account_id, accountId));
    }
    if (user.companyIds !== null) {
      conds.push(
        user.companyIds.length ? inArray(bankCashOuts.entity_id, user.companyIds) : sql`false`,
      );
    }
    const rows = await db
      .select()
      .from(bankCashOuts)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(bankCashOuts.occurred_at), desc(bankCashOuts.cash_out_id))
      .limit(500);
    return Response.json({ cash_outs: rows });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

/**
 * POST /api/bank-accounts/cash-outs — record cash a leader withdrew from a
 * company bank account. Debits the account on the spot, so the CRM's balance
 * matches the bank's; writes a `bank_cash_out` audit row and a system-log
 * line. Any write user in the account's company can record one.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    const body = parsed.data;

    const occurredAt = body.occurred_at ? new Date(body.occurred_at) : new Date();
    if (Number.isNaN(occurredAt.getTime())) return jsonError("Bad occurred_at");
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) {
      return jsonError("The withdrawal time can't be in the future");
    }

    const created = await db.transaction(async (txn) => {
      const [account] = await txn
        .select()
        .from(bankAccounts)
        .where(eq(bankAccounts.account_id, body.account_id))
        .for("update");
      if (!account) throw new AuthError(404, "Account not found");
      if (user.companyIds !== null && !user.companyIds.includes(account.entity_id)) {
        throw new AuthError(403, "Account is outside your company scope");
      }
      if (account.status !== "active") throw new AuthError(422, "Account is inactive");
      if (account.current_balance < body.amount) {
        throw new AuthError(
          422,
          `Insufficient balance (${account.current_balance.toFixed(2)} available)`,
        );
      }

      // Resolve who took it: a named leader entity, or free text. One or the
      // other has to give us a name.
      let takenBy = body.taken_by ?? "";
      let takenByEntityId: number | null = null;
      if (body.taken_by_entity_id) {
        const [leader] = await txn
          .select({ entity_id: entities.entity_id, name: entities.name, type: entities.entity_type })
          .from(entities)
          .where(eq(entities.entity_id, body.taken_by_entity_id));
        if (!leader) throw new AuthError(404, "Leader not found");
        takenByEntityId = leader.entity_id;
        if (!takenBy) takenBy = leader.name;
      }
      if (!takenBy) throw new AuthError(422, "Say who took the cash");

      const nowIso = new Date().toISOString();
      await txn
        .update(bankAccounts)
        .set({ current_balance: +(account.current_balance - body.amount).toFixed(2) })
        .where(eq(bankAccounts.account_id, account.account_id));

      const [row] = await txn
        .insert(bankCashOuts)
        .values({
          account_id: account.account_id,
          entity_id: account.entity_id,
          amount: body.amount,
          taken_by_entity_id: takenByEntityId,
          taken_by: takenBy,
          occurred_at: occurredAt.toISOString(),
          notes: body.notes || null,
          recorded_by_user_id: user.user_id,
          created_at: nowIso,
        })
        .returning();

      await txn.insert(transactions).values({
        entity_id: account.entity_id,
        type: "bank_cash_out",
        amount: body.amount,
        reference_id: row.cash_out_id,
        user_id: user.user_id,
        details: {
          action: "recorded",
          account: account.account_number,
          bank: account.bank_name,
          taken_by: takenBy,
          taken_by_entity_id: takenByEntityId,
          occurred_at: occurredAt.toISOString(),
          balance_after: +(account.current_balance - body.amount).toFixed(2),
        },
      });

      return { row, account };
    });

    await logActivity({
      category: "bank_account",
      action: "bank_account.cash_out",
      summary: `RM ${body.amount.toFixed(2)} cash taken from ${created.account.bank_name} ${
        created.account.account_number
      } by ${created.row.taken_by}`,
      actor: user,
      companyEntityId: created.account.entity_id,
      targetType: "bank_account",
      targetId: created.account.account_id,
      targetLabel: `${created.account.bank_name} ${created.account.account_number}`,
      context: { cash_out_id: created.row.cash_out_id, amount: body.amount },
    });

    return Response.json({ cash_out: created.row }, { status: 201 });
  } catch (e) {
    return authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

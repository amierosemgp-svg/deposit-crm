import { desc, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  bankAccounts,
  entities,
  leaderMemberships,
  leaderTransfers,
  transactions,
  users,
} from "@/db/schema";
import { AuthError, authErrorResponse, requireUser, requireWriteUser } from "@/lib/auth";
import { jsonError, visibleEntityIds } from "@/lib/api-helpers";
import { InsufficientBankBalanceError, moveBankBalance } from "@/lib/bank-balance";
import { logActivity } from "@/lib/activity-log";

const createSchema = z
  .object({
    /** The two people settling up — users with role company_leader. */
    from_leader_user_id: z.number().int().positive(),
    to_leader_user_id: z.number().int().positive(),
    amount: z.number().positive(),
    note: z.string().max(300).optional(),
    // Where the money came from and went. Omit both ends of a side to leave it
    // unrecorded, as every row written before these columns existed.
    from_account_id: z.number().int().positive().nullable().optional(),
    to_account_id: z.number().int().positive().nullable().optional(),
    from_cash: z.boolean().optional(),
    to_cash: z.boolean().optional(),
  })
  .refine((v) => !(v.from_cash && v.from_account_id), {
    message: "The sending end is a bank account or cash, not both",
    path: ["from_account_id"],
  })
  .refine((v) => !(v.to_cash && v.to_account_id), {
    message: "The receiving end is a bank account or cash, not both",
    path: ["to_account_id"],
  });

/**
 * GET /api/leader-transfers — the settlement ledger between leaders.
 *
 * Scoped to the tree the caller can see, not gated on being an admin. A CS desk
 * records these alongside the day's deposits, and a leader needs to read their
 * own; what neither may see is another organisation's settlements, which an
 * unscoped list handed to everyone the moment the tab was opened up.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const visible = await visibleEntityIds(user);
    /**
     * Visible when either person belongs to something the reader can see.
     *
     * The ends are people now, and a person's scope is the company they sit on,
     * so the test goes through users rather than comparing entity ids directly.
     */
    const mine =
      visible === null
        ? sql`true`
        : visible.length
          ? sql`EXISTS (
              SELECT 1 FROM users u
               WHERE u.user_id IN (${leaderTransfers.from_leader_user_id},
                                   ${leaderTransfers.to_leader_user_id})
                 AND u.entity_id IN (${sql.join(
                   visible.map((id) => sql`${id}`),
                   sql`, `,
                 )}))`
          : sql`false`;
    const rows = await db
      .select()
      .from(leaderTransfers)
      .where(mine)
      .orderBy(desc(leaderTransfers.created_at))
      .limit(2000);
    return Response.json({ leader_transfers: rows });
  } catch (e) {
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/** POST /api/leader-transfers — record a transfer between leaders, or one leader's own accounts. */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    /**
     * One leader can move money to themselves — bank to cash, cash to bank,
     * one account to another. That is a real thing they do and it belongs in
     * the same ledger as a settlement between two leaders.
     *
     * What is still refused is a row that moves nothing: the same leader with
     * the same end on both sides, or with neither end named, which records a
     * sum leaving and arriving in the same place. Between two leaders, unnamed
     * ends stay allowed — that is the "not recorded" state every row written
     * before the columns existed is in.
     */
    if (body.from_leader_user_id === body.to_leader_user_id) {
      const sameAccount =
        body.from_account_id != null && body.from_account_id === body.to_account_id;
      const bothCash = !!body.from_cash && !!body.to_cash;
      const neither =
        body.from_account_id == null &&
        body.to_account_id == null &&
        !body.from_cash &&
        !body.to_cash;
      if (sameAccount || bothCash || neither) {
        return jsonError(
          "A leader moving money to themselves needs two different ends — " +
            "one account to another, or between an account and cash",
        );
      }
    }

    // Both ends must be actual leaders — people, not companies.
    const ends = await db
      .select({
        id: entities.entity_id,
        type: entities.entity_type,
        name: entities.name,
        parent: entities.parent_entity_id,
      })
      .from(entities);

    const people = await db
      .select({
        user_id: users.user_id,
        full_name: users.full_name,
        username: users.username,
        role: users.role,
        entity_id: users.entity_id,
      })
      .from(users)
      .where(inArray(users.user_id, [body.from_leader_user_id, body.to_leader_user_id]));
    const personById = new Map(people.map((p) => [p.user_id, p]));
    const from = personById.get(body.from_leader_user_id);
    const to = personById.get(body.to_leader_user_id);
    if (!from || from.role !== "company_leader") return jsonError("From is not a leader");
    if (!to || to.role !== "company_leader") return jsonError("To is not a leader");

    /**
     * Which companies each person holds — the one they sit on plus any granted.
     * An account is theirs if it hangs off one of those, or off a casino under
     * one of them.
     */
    const memberships = await db
      .select({
        user_id: leaderMemberships.user_id,
        leader_entity_id: leaderMemberships.leader_entity_id,
      })
      .from(leaderMemberships)
      .where(inArray(leaderMemberships.user_id, [from.user_id, to.user_id]));
    const companiesOf = (u: { user_id: number; entity_id: number }) => [
      u.entity_id,
      ...memberships.filter((m) => m.user_id === u.user_id).map((m) => m.leader_entity_id),
    ];

    /**
     * One end has to be theirs. Recording a settlement between two organisations
     * neither of which you belong to is not a mistake anyone makes by accident.
     */
    const visible = await visibleEntityIds(user);
    if (
      visible !== null &&
      ![...companiesOf(from), ...companiesOf(to)].some((id) => visible.includes(id))
    ) {
      throw new AuthError(403, "Neither end of that transfer is in your scope");
    }

    /**
     * A named account has to belong to the leader on that side of the transfer.
     *
     * Accounts hang off a leader or off one of its companies, so the check is
     * "the account's entity is the leader, or its parent is" — without it the
     * sheet would happily record one leader paying out of another's Maybank.
     */
    const ownedBy = (companies: number[], entityId: number) =>
      companies.includes(entityId) ||
      ends.some((e) => e.id === entityId && e.parent !== null && companies.includes(e.parent));

    const accountIds = [body.from_account_id, body.to_account_id].filter(
      (id): id is number => typeof id === "number",
    );
    const accounts = accountIds.length
      ? await db
          .select({ id: bankAccounts.account_id, entity_id: bankAccounts.entity_id, label: bankAccounts.label })
          .from(bankAccounts)
          .where(inArray(bankAccounts.account_id, accountIds))
      : [];
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    for (const [side, accountId, person] of [
      ["Sending", body.from_account_id, from],
      ["Receiving", body.to_account_id, to],
    ] as const) {
      if (typeof accountId !== "number") continue;
      const account = accountById.get(accountId);
      if (!account) return jsonError(`${side} bank account not found`, 404);
      if (!ownedBy(companiesOf(person), account.entity_id)) {
        return jsonError(
          `${side} bank account does not belong to a company ${person.full_name} holds`,
        );
      }
    }

    /**
     * A named account moves; cash doesn't.
     *
     * These rows used to record where money went without moving anything, on
     * the grounds that a settlement between leaders is their business. But the
     * moment a row names one of our accounts, it is making a claim about that
     * account's balance — a leader paying RM 1,000 of their own cash into the
     * company Maybank means the Maybank has RM 1,000 more, and the CRM saying
     * otherwise is just wrong. Cash ends move nothing because cash is not a
     * balance the CRM keeps; it is what the row is telling us about.
     *
     * Note this is the same money a Bank Transfer would move if the pair were
     * also recorded there — record each movement once.
     */
    const created = await db.transaction(async (txn) => {
      const [row] = await txn
        .insert(leaderTransfers)
        .values({
          from_leader_user_id: body.from_leader_user_id,
          to_leader_user_id: body.to_leader_user_id,
          amount: body.amount,
          from_account_id: body.from_account_id ?? null,
          to_account_id: body.to_account_id ?? null,
          from_cash: body.from_cash ?? false,
          to_cash: body.to_cash ?? false,
          note: body.note ?? null,
          created_by_user_id: user.user_id,
        })
        .returning();

      const balances: Record<string, number> = {};
      if (body.from_account_id != null) {
        balances.from_balance_after = await moveBankBalance(txn, {
          accountId: body.from_account_id,
          delta: -body.amount,
        });
      }
      if (body.to_account_id != null) {
        balances.to_balance_after = await moveBankBalance(txn, {
          accountId: body.to_account_id,
          delta: body.amount,
        });
      }

      // One audit row for the unified history + the transaction filter. Kept as
      // its own type (never "expense"), scoped to the sending leader's company.
      await txn.insert(transactions).values({
        entity_id: from.entity_id,
        type: "leader_transfer",
        amount: body.amount,
        reference_id: row.transfer_id,
        user_id: user.user_id,
        details: {
          from_leader_user_id: body.from_leader_user_id,
          from_leader: from.full_name,
          to_leader_user_id: body.to_leader_user_id,
          to_leader: to.full_name,
          from: body.from_cash
            ? "cash"
            : (accountById.get(body.from_account_id ?? -1)?.label ?? null),
          to: body.to_cash
            ? "cash"
            : (accountById.get(body.to_account_id ?? -1)?.label ?? null),
          note: body.note ?? null,
          ...balances,
        },
      });

      return row;
    });

    await logActivity({
      category: "entity",
      action: "leader_transfer.created",
      summary: `Leader transfer: ${from.full_name} → ${to.full_name}, RM ${body.amount.toFixed(2)}`,
      actor: user,
      targetType: "leader_transfer",
      targetId: created.transfer_id,
      context: { amount: body.amount, note: body.note ?? null },
    });

    return Response.json({ leader_transfer: created }, { status: 201 });
  } catch (e) {
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

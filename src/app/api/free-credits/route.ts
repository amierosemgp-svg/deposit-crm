import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireUser, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { issueFreeCredit } from "@/lib/free-credit";

const createSchema = z.object({
  player_id: z.number().int().positive(),
  game_name: z.string().min(1),
  // Which login under the game to credit. Omit for the player's first account.
  game_username: z.string().max(120).optional(),
  amount: z.number().positive(),
  // Why the credit was given — "rebate", "compensation", a promo name. Free
  // text; it is the column the workbook's Free Credit sheet kept as Remark.
  reason: z.string().max(200).optional(),
  // true = CS already credited the game in the provider back-office; book it
  // now. false = queue a credit-in for the agent to perform.
  skip_bot: z.boolean().optional(),
});

/**
 * POST /api/free-credits — CS injects game credit with no deposit behind it
 * (a rebate, a goodwill credit, a promo), the workbook's "Free Credit" sheet.
 *
 * Rides the same two rails as a referral-bonus payout:
 *   - skip_bot: CS did it in the back-office themselves — the player's balance
 *     and the company BO pool are booked here and now.
 *   - otherwise: a credit-in game transfer (from_game === to_game) is queued;
 *     the balance moves when the agent reports it completed.
 *
 * Either way one `game_topup` audit row with details.action = "free_credit" is
 * written at creation — that row IS the Free Credit ledger the CRM lists, so a
 * queued agent credit shows up the moment CS enters it, not minutes later.
 */
export async function POST(request: Request) {
  try {
    const user = await requireWriteUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const { player_id, game_name, game_username, amount, reason, skip_bot = false } = parsed.data;

    const result = await db.transaction(async (txn) => {
      const [player] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, player_id));
      if (!player) throw new AuthError(404, "Player not found");
      if (
        user.companyIds !== null &&
        !user.companyIds.includes(player.company_entity_id)
      ) {
        throw new AuthError(403, "Player is outside your company scope");
      }

      const issued = await issueFreeCredit(txn, {
        user,
        player,
        gameName: game_name,
        gameUsername: game_username,
        amount,
        reason,
        skipBot: skip_bot,
      });
      return issued;
    });

    return Response.json(
      { free_credit: { transaction_id: result.transactionId, game_transfer_id: result.gameTransferId } },
      { status: 201 },
    );
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/**
 * GET /api/free-credits — the Free Credit sheet's rows: every credit injected
 * without a deposit, newest last is the caller's job (rows come newest first).
 * Scoped to the requesting user's companies. For agent-queued rows the live
 * status lives on the referenced game transfer, which the client already holds.
 */
export async function GET() {
  try {
    const user = await requireUser();

    const conds = [
      eq(transactions.type, "game_topup"),
      sql`${transactions.details}->>'action' = 'free_credit'`,
    ];
    if (user.companyIds !== null) {
      conds.push(
        user.companyIds.length
          ? inArray(transactions.entity_id, user.companyIds)
          : sql`false`,
      );
    }
    // CS agents see a rolling day, matching the rest of the sheet.
    if (user.role === "cs_agent") {
      conds.push(
        gte(
          transactions.created_at,
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        ),
      );
    }

    const rows = await db
      .select()
      .from(transactions)
      .where(and(...conds))
      .orderBy(desc(transactions.created_at))
      .limit(2000);

    return Response.json({
      free_credits: rows.map((r) => ({
        transaction_id: r.transaction_id,
        created_at: r.created_at,
        player_id: r.player_id,
        entity_id: r.entity_id,
        game_name: r.game_name,
        amount: r.amount,
        user_id: r.user_id,
        reason: (r.details?.reason as string | null) ?? null,
        source: (r.details?.source as string) ?? "manual",
        game_transfer_id: (r.details?.game_transfer_id as number | null) ?? null,
      })),
    });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

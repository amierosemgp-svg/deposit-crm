import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  gameCredits,
  gameTransfers,
  players,
  referralBonuses,
  transactions,
} from "@/db/schema";
import { requireBotKey } from "@/lib/bot-auth";
import {
  creditRecommendBonus,
  InsufficientBoCreditError,
} from "@/lib/referral";
import {
  BotError,
  botErrorResponse,
  gameTransferJson,
  jsonError,
} from "@/lib/bot-crud";
import {
  CREDIT_CONFLICT_TARGET,
  creditWhere,
  resolveGameLogin,
} from "@/lib/game-credits";

const bodySchema = z.object({
  status: z.enum(["processing", "completed", "failed"]),
  note: z.string().max(500).optional(),
  // What you actually moved. Authoritative — it wins over our cached balance,
  // and it is the only way a transfer_all transfer learns its real figure.
  amount: z.number().nonnegative().optional(),
});

/** Statuses a transfer can still be driven out of. */
const OPEN_STATUSES = ["pending", "solving", "processing"] as const;

/**
 * PATCH /api/bot/game-transfers/:id/status
 * The agent drives a CS-requested game credit transfer through its lifecycle:
 *
 *   pending ──claim──▶ processing ──▶ completed
 *      ▲                   │       └─▶ failed
 *      └─ solving ◀─stalled┘
 *
 *   - processing: claim it — you're starting the back-office move now. From
 *     "pending" or "solving" only; claiming twice is a no-op, not an error, so
 *     a retried claim after a timeout is safe.
 *   - completed: credits move from_game → to_game atomically (validated under a
 *     row lock — the balance may have changed since the request). Send
 *     `amount` — what you really moved; it overwrites our figure. Required in
 *     practice for `transfer_all` transfers, which carry 0 until you say
 *     otherwise.
 *   - failed: no credits move, nothing to reverse. Send a `note` saying why.
 *
 * Claiming is optional: an agent that goes straight from pending to completed
 * still works. It only costs you the "is anyone actually on this" signal.
 * A transfer that already reached a terminal state is a 409.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireBotKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const transferId = Number(id);
  if (!Number.isInteger(transferId) || transferId <= 0) {
    return jsonError("Invalid transfer id");
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Provide status: completed | failed (optional note)");
  }
  const body = parsed.data;

  try {
    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(gameTransfers)
        .where(eq(gameTransfers.transfer_id, transferId))
        .for("update");
      if (!row) throw new BotError(404, "Game transfer not found");
      if (!(OPEN_STATUSES as readonly string[]).includes(row.status)) {
        throw new BotError(
          409,
          `Transfer already ${row.status} — it can't be changed`,
        );
      }

      const nowIso = new Date().toISOString();
      // from_game === to_game is not a move — it's a credit-in riding this
      // queue because it is the only "go do something in the back-office"
      // queue the agent polls. Two things produce the shape: a recommend bonus
      // (/api/referral-bonuses/:id/assign) and a free credit
      // (/api/free-credits). POST /api/game-transfers rejects from === to, so
      // nothing else can.
      const creditIn = row.from_game.toLowerCase() === row.to_game.toLowerCase();
      // Which of the two it is only matters for the ledger label below — a
      // referral bonus row pointing at this transfer settles it.
      let isReferralCredit = false;
      if (creditIn) {
        const [ref] = await txn
          .select({ bonus_id: referralBonuses.bonus_id })
          .from(referralBonuses)
          .where(eq(referralBonuses.game_transfer_id, row.transfer_id))
          .limit(1);
        isReferralCredit = !!ref;
      }

      // What actually moved. Starts as the requested figure and is replaced by
      // the agent's own once it reports one; persisted onto the row below so
      // the ledger and the CRM show the real number, not the placeholder.
      let moved = row.transfer_amount;

      // Claiming: mark that the agent has started, and restart the stall clock so
      // the 5-minute sweep measures from "work began", not "CS asked".
      if (body.status === "processing") {
        const [owner] = await txn
          .select({ game_accounts: players.game_accounts })
          .from(players)
          .where(eq(players.player_id, row.player_id));

        // Already claimed — a retried claim after a timeout, not an error.
        if (row.status === "processing") {
          return { transfer: row, gameAccounts: owner?.game_accounts ?? null };
        }

        const [claimed] = await txn
          .update(gameTransfers)
          .set({
            status: "processing",
            started_at: nowIso,
            note: body.note ?? row.note,
          })
          .where(eq(gameTransfers.transfer_id, transferId))
          .returning();
        return { transfer: claimed, gameAccounts: owner?.game_accounts ?? null };
      }

      if (body.status === "completed") {
        if (creditIn) {
          // A recommend bonus riding the transfer queue (see the note on
          // `creditIn` above). It is a top-up, not a move: there is no source
          // balance to debit — the credit is issued from the company's BO pool,
          // exactly as a deposit top-up is.
          const [owner] = await txn
            .select({
              company_entity_id: players.company_entity_id,
              game_accounts: players.game_accounts,
            })
            .from(players)
            .where(eq(players.player_id, row.player_id));
          try {
            moved = body.amount ?? row.transfer_amount;
            await creditRecommendBonus(txn, {
              playerId: row.player_id,
              companyEntityId: owner?.company_entity_id ?? null,
              gameName: row.to_game,
              // The credit-in row carries its target login; fall back to the
              // player's first account for the game.
              gameUsername: resolveGameLogin(
                owner?.game_accounts ?? null,
                row.to_game,
                row.to_game_username,
              ),
              amount: moved,
              nowIso,
            });
          } catch (e) {
            if (e instanceof InsufficientBoCreditError) {
              throw new BotError(422, e.message);
            }
            throw e;
          }
        } else {
          // Which logins the move is between — the transfer's own, else the
          // player's first account for each game.
          const [mover] = await txn
            .select({ game_accounts: players.game_accounts })
            .from(players)
            .where(eq(players.player_id, row.player_id));
          const fromLogin = resolveGameLogin(
            mover?.game_accounts ?? null,
            row.from_game,
            row.from_game_username,
          );
          const toLogin = resolveGameLogin(
            mover?.game_accounts ?? null,
            row.to_game,
            row.to_game_username,
          );

          // Re-validate the source balance atomically — it may have moved since
          // the CS request created this transfer. Matched on the (game, login)
          // pair, case-insensitively, like the unique index on game_credits.
          const [fromCredit] = await txn
            .select()
            .from(gameCredits)
            .where(creditWhere(row.player_id, row.from_game, fromLogin))
            .for("update");
          const fromBalance = fromCredit?.current_balance ?? 0;

          // What moved, in order of authority: the agent's own figure, then —
          // for transfer_all, which carries no figure of its own — the whole
          // source balance, then the amount CS asked for.
          moved =
            body.amount ?? (row.transfer_all ? fromBalance : row.transfer_amount);
          if (moved <= 0) {
            throw new BotError(
              422,
              `Nothing to transfer from ${row.from_game} (balance ${fromBalance.toFixed(2)})`,
            );
          }
          if (fromBalance < moved) {
            throw new BotError(
              422,
              `Insufficient ${row.from_game} balance (${fromBalance.toFixed(2)} available, ${moved.toFixed(2)} needed)`,
            );
          }

          // Write back under the spelling already on file, so a case variant in
          // the transfer row can't fork the balance the index now forbids.
          const fromName = fromCredit?.game_name ?? row.from_game;
          const fromUser = fromCredit?.game_username ?? fromLogin;
          await txn
            .update(gameCredits)
            .set({
              current_balance: +(fromBalance - moved).toFixed(2),
              last_updated_at: nowIso,
            })
            .where(
              and(
                eq(gameCredits.player_id, row.player_id),
                eq(gameCredits.game_name, fromName),
                eq(gameCredits.game_username, fromUser),
              ),
            );

          // Same for the destination: resolve to the existing row's spelling
          // before upserting, or the case-sensitive primary key would miss the
          // conflict and the case-insensitive unique index would reject the
          // insert outright.
          const [toCredit] = await txn
            .select({
              game_name: gameCredits.game_name,
              game_username: gameCredits.game_username,
            })
            .from(gameCredits)
            .where(creditWhere(row.player_id, row.to_game, toLogin))
            .for("update");
          const toName = toCredit?.game_name ?? row.to_game;
          const toUser = toCredit?.game_username ?? toLogin;
          await txn
            .insert(gameCredits)
            .values({
              player_id: row.player_id,
              game_name: toName,
              game_username: toUser,
              current_balance: moved,
              last_updated_at: nowIso,
            })
            .onConflictDoUpdate({
              target: [...CREDIT_CONFLICT_TARGET],
              set: {
                current_balance: sql`${gameCredits.current_balance} + ${moved}`,
                last_updated_at: nowIso,
              },
            });
        }
      }

      const [updated] = await txn
        .update(gameTransfers)
        .set({
          status: body.status,
          // Replace the placeholder with what was really moved, so the list,
          // the ledger and any later reprocess all read the same number.
          ...(body.status === "completed" ? { transfer_amount: moved } : {}),
          completed_at: nowIso,
          // Keep the reason on the row itself, not just buried in the audit
          // trail — CS reads it off the transfer list.
          note: body.note ?? null,
          // A transfer that somehow reached here without a start time still
          // gets one, so the UI never shows an end without a start.
          started_at: row.started_at ?? row.created_at,
        })
        .where(eq(gameTransfers.transfer_id, transferId))
        .returning();

      const [player] = await txn
        .select({
          company_entity_id: players.company_entity_id,
          game_accounts: players.game_accounts,
        })
        .from(players)
        .where(eq(players.player_id, row.player_id));

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: player?.company_entity_id ?? null,
        // A credit-in lands in the ledger under the same type as its
        // hand-credited path: recommend_bonus for a referral payout,
        // game_topup for a free credit.
        type: creditIn
          ? isReferralCredit
            ? "recommend_bonus"
            : "game_topup"
          : "game_transfer",
        amount: body.status === "completed" ? moved : row.transfer_amount,
        game_name: creditIn ? row.to_game : `${row.from_game} → ${row.to_game}`,
        reference_id: row.transfer_id,
        details: {
          source: "bot",
          action: body.status,
          // Marks a free-credit credit-in's outcome row. Deliberately not
          // "free_credit" — that value is the creation row's, and the Free
          // Credit list must see each injection exactly once.
          ...(creditIn && !isReferralCredit ? { free_credit: true } : {}),
          api_key_label: auth.label,
          note: body.note ?? null,
          ...(row.transfer_all ? { transfer_all: true } : {}),
          // Present when the agent's figure differed from the one requested.
          ...(body.status === "completed" && moved !== row.transfer_amount
            ? { requested_amount: row.transfer_amount, reported_amount: moved }
            : {}),
        },
      });

      return { transfer: updated, gameAccounts: player?.game_accounts ?? null };
    });

    return Response.json({
      transfer: gameTransferJson(result.transfer, {
        game_accounts: result.gameAccounts,
      }),
    });
  } catch (e) {
    return botErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500));
  }
}

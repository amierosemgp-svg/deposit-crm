import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameTransfers, players, rebatePayouts, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { assertNotArchived, jsonError } from "@/lib/api-helpers";
import {
  appendEditNote,
  describeChanges,
  diffFields,
  logActivity,
} from "@/lib/activity-log";
import {
  adjustGameCredit,
  applyCreditRebook,
  holdsGameLogin,
  resolveGameLogin,
} from "@/lib/game-credits";
import { assertFreeCreditEditWithinCap } from "@/lib/free-credit";
import { canonicalise } from "@/lib/game-name";
import { InsufficientKioskCreditError, moveKioskCredit } from "@/lib/kiosk-credit";

/**
 * DELETE /api/free-credits/:id — remove a free credit keyed wrong, and take
 * the credit back out.
 *
 * The id is the ledger row's transaction_id: that `game_topup` row with
 * details.action = "free_credit" IS the Free Credit sheet's row, so removing
 * it is what makes the line disappear.
 *
 * What comes back depends on how far the credit got:
 *   - credited by hand (the normal case) — the member's balance goes down by
 *     the amount and the kiosk float gets it back, the exact reverse of what
 *     issueFreeCredit laid down;
 *   - still queued for the agent — nothing has moved yet, so the queued
 *     transfer is cancelled and no balance is touched;
 *   - queued and already done by the agent — reversed like a hand credit,
 *     because the money did move.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const transactionId = Number((await params).id);

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(transactions)
        .where(eq(transactions.transaction_id, transactionId))
        .for("update");
      if (!row) throw new AuthError(404, "Free credit not found");

      const details = (row.details ?? {}) as {
        action?: string;
        reason?: string;
        game_username?: string;
        game_transfer_id?: number;
      };
      if (row.type !== "game_topup" || details.action !== "free_credit") {
        throw new AuthError(409, "That row is not a free credit");
      }
      if (row.entity_id !== null && user.companyIds !== null && !user.companyIds.includes(row.entity_id)) {
        throw new AuthError(403, "Free credit is outside your company scope");
      }
      /**
       * Only the person holding the row may remove it, as on deposits and
       * withdrawals. A free credit has no assignee column — the ledger row's
       * user_id is who issued it, and that is who holds it.
       */
      if (row.user_id !== user.user_id) {
        throw new AuthError(
          409,
          row.user_id === null
            ? "That free credit has no owner — an admin has to remove it"
            : "That free credit was issued by someone else",
        );
      }

      /**
       * A queued credit the agent has not performed has moved nothing — cancel
       * the transfer and leave every balance alone. One it has completed moved
       * the same two figures a hand credit does, so it unwinds the same way.
       */
      const [player] = row.player_id
        ? await txn.select().from(players).where(eq(players.player_id, row.player_id))
        : [undefined];

      let queuedUnperformed = false;
      if (details.game_transfer_id) {
        const [transfer] = await txn
          .select()
          .from(gameTransfers)
          .where(eq(gameTransfers.transfer_id, details.game_transfer_id))
          .for("update");
        if (transfer && transfer.status !== "completed") {
          queuedUnperformed = true;
          await txn
            .delete(gameTransfers)
            .where(eq(gameTransfers.transfer_id, details.game_transfer_id));
        }
      }

      if (!queuedUnperformed && row.player_id && row.game_name) {
        const gameName = await canonicalise(row.game_name, txn);
        const login = resolveGameLogin(
          player?.game_accounts ?? null,
          gameName,
          details.game_username ?? null,
        );
        await adjustGameCredit(txn, {
          playerId: row.player_id,
          gameName,
          gameUsername: login,
          delta: -row.amount,
          nowIso: new Date().toISOString(),
        });
        await moveKioskCredit(txn, {
          companyEntityId: row.entity_id,
          gameName,
          delta: row.amount,
        });
      }

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: row.entity_id,
        type: "game_topup",
        amount: -row.amount,
        game_name: row.game_name,
        user_id: user.user_id,
        details: {
          source: "manual",
          action: "free_credit_deleted",
          free_credit_transaction_id: row.transaction_id,
          reason: details.reason ?? null,
          amount: row.amount,
          player_username: player?.username ?? null,
          // The row's own timestamp. Two free credits to one member on one
          // shift can be identical in every other column, and telling them
          // apart is the whole point of the log when one was keyed twice.
          issued_at: row.created_at,
          credit_taken_back: !queuedUnperformed,
        },
      });

      await txn.delete(transactions).where(eq(transactions.transaction_id, transactionId));
      return { row, player, queuedUnperformed };
    });

    await logActivity({
      category: "transaction",
      action: "free_credit.deleted",
      summary:
        `Free credit deleted: ${result.player?.username ?? "unassigned"} — ` +
        `RM ${result.row.amount.toFixed(2)} ${result.row.game_name ?? ""}`.trimEnd() +
        ` (issued ${result.row.created_at})` +
        (result.queuedUnperformed ? ", was still queued" : ""),
      actor: user,
      companyEntityId: result.row.entity_id,
      targetType: "transaction",
      targetId: result.row.transaction_id,
      targetLabel: result.row.game_name ?? "free credit",
      context: {
        amount: result.row.amount,
        player_username: result.player?.username ?? null,
        issued_at: result.row.created_at,
        reason: (result.row.details as { reason?: string } | null)?.reason ?? null,
        queued: result.queuedUnperformed,
      },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

const patchSchema = z.object({
  // Member — moves the credit to another player's wallet.
  player_id: z.number().int().positive().optional(),
  // Product — the game it was credited in.
  game_name: z.string().min(1).max(60).optional(),
  // Which login under the game. null = the player's first account for it.
  game_username: z.string().max(120).nullable().optional(),
  amount: z.number().positive().optional(),
  // Remark. null or "" clears it.
  reason: z.string().max(200).nullable().optional(),
  // Date and time, as one instant: the sheet's two cells are one column here.
  created_at: z.string().datetime({ offset: true }).optional(),
});

type FreeCreditDetails = {
  action?: string;
  source?: string;
  reason?: string | null;
  game_username?: string;
  game_transfer_id?: number | null;
  rebate_payout_id?: number;
  edit_note?: string;
};

/** A ledger row in the shape GET /api/free-credits lists it, so the sheet can splice it in. */
function freeCreditJson(r: typeof transactions.$inferSelect) {
  const d = (r.details ?? {}) as FreeCreditDetails;
  return {
    transaction_id: r.transaction_id,
    created_at: r.created_at,
    player_id: r.player_id,
    entity_id: r.entity_id,
    game_name: r.game_name,
    amount: r.amount,
    user_id: r.user_id,
    reason: d.reason ?? null,
    source: d.source ?? "manual",
    game_transfer_id: d.game_transfer_id ?? null,
  };
}

/**
 * PATCH /api/free-credits/:id — correct a free credit CS credited by hand.
 *
 * Every typed-in cell of the sheet row is open: member, product, login,
 * amount, remark, date. Open to anyone who can write, not just whoever issued
 * it — unlike DELETE, which can't be walked back, a correction can be
 * corrected again, and the desk that spots the wrong figure is usually not
 * the desk that typed it. The log carries who changed what.
 *
 * Manual rows only (details.source = "manual", nothing queued). A credit the
 * agent performed is the agent's record of what it did at the provider, and
 * rewriting it here would leave the CRM claiming something the kiosk never
 * saw; one still queued belongs to the agent until it finishes.
 *
 * A manual credit has already booked, so an edit re-books: the old credit
 * comes out of the old wallet and goes back to the old kiosk float, the new
 * one is spent from the new float into the new wallet — netted, in the same
 * transaction, under a lock on the ledger row. The row itself is updated in
 * place: it IS the Free Credit sheet's line, and the totals every report sums.
 *
 * There is no status to set. A free credit's ledger row has no status column —
 * a manual one is "Credited" by construction — and every report sums these
 * rows unfiltered, so a "failed" flag in details would leave them all counting
 * money that never moved. "It never happened" is DELETE.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const transactionId = Number((await params).id);
    if (!Number.isInteger(transactionId) || transactionId <= 0) {
      return jsonError("Invalid free credit id");
    }

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(transactions)
        .where(eq(transactions.transaction_id, transactionId))
        .for("update");
      if (!row) throw new AuthError(404, "Free credit not found");

      const details = (row.details ?? {}) as FreeCreditDetails;
      if (row.type !== "game_topup" || details.action !== "free_credit") {
        throw new AuthError(409, "That row is not a free credit");
      }
      if (row.entity_id !== null && user.companyIds !== null && !user.companyIds.includes(row.entity_id)) {
        throw new AuthError(403, "Free credit is outside your company scope");
      }
      // The same test the sheet uses to call a row manual: no source means a
      // row written before the field existed, which were all hand credits.
      if ((details.source ?? "manual") !== "manual" || details.game_transfer_id) {
        throw new AuthError(
          409,
          "That free credit went through the agent — only manual rows can be edited",
        );
      }
      if (row.player_id === null || !row.game_name) {
        throw new AuthError(409, "That free credit has no member or game to re-book against");
      }

      const [oldPlayer] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, row.player_id));
      if (!oldPlayer) throw new AuthError(404, "The credited player no longer exists");

      let newPlayer = oldPlayer;
      if (body.player_id !== undefined && body.player_id !== row.player_id) {
        const [p] = await txn
          .select()
          .from(players)
          .where(eq(players.player_id, body.player_id));
        if (!p) throw new AuthError(404, "Player not found");
        if (user.companyIds !== null && !user.companyIds.includes(p.company_entity_id)) {
          throw new AuthError(403, "Player is outside your company scope");
        }
        assertNotArchived(p);
        newPlayer = p;
      }
      const playerChanged = newPlayer.player_id !== oldPlayer.player_id;

      const oldGame = await canonicalise(row.game_name, txn);
      const newGame =
        body.game_name !== undefined ? await canonicalise(body.game_name, txn) : oldGame;
      const gameChanged = newGame.toLowerCase() !== oldGame.toLowerCase();

      const oldLogin = resolveGameLogin(oldPlayer.game_accounts, oldGame, details.game_username ?? null);
      /**
       * The login follows the request, else the row — unless the member or the
       * game moved, in which case the old login belongs to someone or
       * something else and the new pair's first account is the honest default.
       */
      const newLogin =
        body.game_username !== undefined
          ? resolveGameLogin(newPlayer.game_accounts, newGame, body.game_username)
          : playerChanged || gameChanged
            ? resolveGameLogin(newPlayer.game_accounts, newGame, null)
            : oldLogin;

      if (playerChanged || gameChanged) {
        // As at creation: credit has to land in an account the player holds.
        const hasGame = (newPlayer.game_accounts ?? []).some(
          (g) => g.game_name.toLowerCase() === newGame.toLowerCase(),
        );
        if (!hasGame) {
          throw new AuthError(422, `${newPlayer.username} has no ${newGame} account linked`);
        }
      }
      if (
        newLogin.toLowerCase() !== oldLogin.toLowerCase() &&
        !holdsGameLogin(newPlayer.game_accounts, newGame, newLogin)
      ) {
        throw new AuthError(422, `${newPlayer.username} has no ${newGame} login "${newLogin}"`);
      }

      const newAmount = body.amount ?? row.amount;
      // Same instant in another spelling ("+08:00" against Postgres's "+00")
      // is not an edit.
      const newCreatedAt =
        body.created_at !== undefined && Date.parse(body.created_at) !== Date.parse(row.created_at)
          ? body.created_at
          : row.created_at;
      const newReason =
        body.reason !== undefined ? (body.reason?.trim() || null) : (details.reason ?? null);

      /**
       * A rebate's credit is the rebate plan's arithmetic for one member. The
       * figure and the member are the payout's, not the sheet's — change them
       * here and the Rebates page says one thing while the wallet says another.
       * Where it landed (game, login) is the desk's to fix, and is mirrored
       * onto the payout so the two keep agreeing.
       */
      if (details.rebate_payout_id) {
        if (playerChanged || newAmount !== row.amount) {
          throw new AuthError(
            409,
            "That free credit pays a rebate — its member and amount come from the rebate and can't be edited here",
          );
        }
      }

      const companyChanged = newPlayer.company_entity_id !== row.entity_id;
      const amountChanged = newAmount !== row.amount;
      const loginChanged = newLogin.toLowerCase() !== oldLogin.toLowerCase();
      const dateChanged = newCreatedAt !== row.created_at;

      if (amountChanged || companyChanged || dateChanged) {
        await assertFreeCreditEditWithinCap(
          txn,
          { companyEntityId: row.entity_id, createdAt: row.created_at, amount: row.amount },
          {
            companyEntityId: newPlayer.company_entity_id,
            createdAt: newCreatedAt,
            amount: newAmount,
          },
        );
      }

      const nowIso = new Date().toISOString();
      const rebooks =
        playerChanged || gameChanged || loginChanged || amountChanged || companyChanged;
      let negativeWallets: Array<{ game: string; login: string; balance: number }> = [];
      if (rebooks) {
        // Out with the old credit, in with the new; netted, so a pure amount
        // change only moves the difference.
        ({ negativeWallets } = await applyCreditRebook(
          txn,
          [
            { kind: "wallet", playerId: oldPlayer.player_id, gameName: oldGame, login: oldLogin, delta: -row.amount },
            { kind: "kiosk", companyEntityId: row.entity_id, gameName: oldGame, delta: row.amount },
            { kind: "wallet", playerId: newPlayer.player_id, gameName: newGame, login: newLogin, delta: newAmount },
            { kind: "kiosk", companyEntityId: newPlayer.company_entity_id, gameName: newGame, delta: -newAmount },
          ],
          nowIso,
        ));
      }

      if (details.rebate_payout_id && (gameChanged || loginChanged)) {
        await txn
          .update(rebatePayouts)
          .set({ game_name: newGame, game_username: newLogin })
          .where(eq(rebatePayouts.payout_id, details.rebate_payout_id));
      }

      const before = {
        player_username: oldPlayer.username,
        game_name: oldGame,
        game_username: oldLogin,
        amount: row.amount,
        reason: details.reason ?? null,
        created_at: row.created_at,
      };
      const after = {
        player_username: newPlayer.username,
        game_name: newGame,
        game_username: newLogin,
        amount: newAmount,
        reason: newReason,
        created_at: newCreatedAt,
      };
      const changes = diffFields(before, after);
      if (!changes.length) {
        return { row, saved: row, before, changes, negativeWallets, player: newPlayer };
      }

      const [saved] = await txn
        .update(transactions)
        .set({
          player_id: newPlayer.player_id,
          entity_id: newPlayer.company_entity_id,
          amount: newAmount,
          game_name: newGame,
          created_at: newCreatedAt,
          details: {
            ...details,
            game_username: newLogin,
            reason: newReason,
            // Who corrected it, kept on the row the way deposits keep theirs.
            edit_note: appendEditNote(details.edit_note, user, changes),
          },
        })
        .where(eq(transactions.transaction_id, transactionId))
        .returning();

      /**
       * The correction on the ledger, beside the row it corrects. Its own
       * action so the Free Credit list and every report — which sum
       * action = "free_credit" — never count it; amount is what the edit added
       * or took back.
       */
      await txn.insert(transactions).values({
        player_id: newPlayer.player_id,
        entity_id: newPlayer.company_entity_id,
        type: "game_topup",
        amount: +(newAmount - row.amount).toFixed(2),
        game_name: newGame,
        user_id: user.user_id,
        details: {
          source: "manual",
          action: "free_credit_edited",
          free_credit_transaction_id: row.transaction_id,
          rebooked: rebooks,
          before,
          after,
          ...(details.rebate_payout_id ? { rebate_payout_id: details.rebate_payout_id } : {}),
        },
      });

      return { row, saved, before, changes, negativeWallets, player: newPlayer };
    });

    if (result.changes.length) {
      await logActivity({
        category: "transaction",
        action: "free_credit.edited",
        summary:
          `Free credit edited: ${result.player.username} ` +
          `(issued ${result.row.created_at}) — ${describeChanges(result.changes)}`,
        actor: user,
        companyEntityId: result.saved.entity_id,
        targetType: "transaction",
        targetId: result.saved.transaction_id,
        targetLabel: result.saved.game_name ?? "free credit",
        changes: result.changes,
        context: { before: result.before },
      });
    }

    return Response.json({
      free_credit: freeCreditJson(result.saved),
      ...(result.negativeWallets.length
        ? {
            warning:
              `Corrected, but the player has already spent some of it — ` +
              result.negativeWallets
                .map((w) => `${w.game}${w.login ? ` ${w.login}` : ""} is now ${w.balance.toFixed(2)}`)
                .join(", ") +
              `. Sync the kiosk balance.`,
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof InsufficientKioskCreditError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

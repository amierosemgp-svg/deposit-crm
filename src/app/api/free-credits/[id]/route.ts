import { eq } from "drizzle-orm";
import { db } from "@/db";
import { gameTransfers, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity-log";
import { adjustGameCredit, resolveGameLogin } from "@/lib/game-credits";
import { canonicalise } from "@/lib/game-name";
import { moveKioskCredit } from "@/lib/kiosk-credit";

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

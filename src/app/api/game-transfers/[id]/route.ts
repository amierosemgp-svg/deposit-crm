import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { gameTransfers, players, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { assertNotArchived, jsonError } from "@/lib/api-helpers";
import { describeChanges, diffFields, logActivity } from "@/lib/activity-log";
import {
  applyCreditRebook,
  holdsGameLogin,
  resolveGameLogin,
  type CreditLeg,
} from "@/lib/game-credits";
import { canonicalise } from "@/lib/game-name";
import { InsufficientKioskCreditError } from "@/lib/kiosk-credit";

const patchSchema = z.object({
  // Member — moves the transfer to another player's wallets.
  player_id: z.number().int().positive().optional(),
  from_game: z.string().min(1).max(60).optional(),
  // Which login under each game. null = the player's first account for it.
  from_game_username: z.string().max(120).nullable().optional(),
  to_game: z.string().min(1).max(60).optional(),
  to_game_username: z.string().max(120).nullable().optional(),
  amount: z.number().positive().optional(),
  // null or "" clears it.
  note: z.string().max(500).nullable().optional(),
  /**
   * A manual move is either done or it isn't. "failed" takes a booked move
   * back out; "completed" books one that was marked failed. The in-flight
   * statuses are the agent's and are not settable here.
   */
  status: z.enum(["completed", "failed"]).optional(),
  // Date and time, as one instant: the sheet's two cells are one column here.
  created_at: z.string().datetime({ offset: true }).optional(),
});

/**
 * PATCH /api/game-transfers/:id — correct a game transfer CS made by hand.
 *
 * Every typed-in cell of the sheet row is open — member, from game and login,
 * to game and login, amount, note, date — and so is Status, between
 * completed and failed. Open to anyone who can write: the assignee claim is
 * a "who's working this" marker for the agent queue, and a manual row is
 * already worked. The log carries who changed what.
 *
 * Manual rows only (skip_bot = true). A transfer the agent ran is its record
 * of what it did at the provider; rewriting it here would leave the CRM
 * claiming a move the kiosk never saw. skip_bot null — rows from before the
 * column — is unknown, and unknown is not manual. A credit-in (from_game ===
 * to_game) is a free credit's or a referral payout's queue entry, and is
 * corrected from there.
 *
 * A completed manual move has already booked, so an edit re-books under a
 * lock on the transfer row, in one transaction:
 *   - out with the old: the from-wallet gets the amount back, the to-wallet
 *     gives it up, and the two kiosk floats swap back (from spends, to
 *     regains) — the exact reverse of POST;
 *   - in with the new: the same four legs the other way, on the new games,
 *     logins, member and amount.
 * Both halves are netted per wallet and per float, so changing only the amount
 * moves only the difference. Marking it failed lays down only the first half;
 * marking a failed one completed only the second. A failed row whose status
 * isn't changing has nothing booked, and its cells are just text.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const transferId = Number((await params).id);
    if (!Number.isInteger(transferId) || transferId <= 0) {
      return jsonError("Invalid transfer id");
    }

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(gameTransfers)
        .where(eq(gameTransfers.transfer_id, transferId))
        .for("update");
      if (!row) throw new AuthError(404, "Transfer not found");

      const [oldPlayer] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, row.player_id));
      if (!oldPlayer) throw new AuthError(404, "Player not found");
      if (user.companyIds !== null && !user.companyIds.includes(oldPlayer.company_entity_id)) {
        throw new AuthError(403, "Transfer is outside your company scope");
      }

      if (row.skip_bot !== true) {
        throw new AuthError(
          409,
          row.skip_bot === false
            ? "That transfer is the agent's — only manual rows can be edited"
            : "That transfer predates the manual flag — it can't be edited here",
        );
      }
      if (row.from_game.toLowerCase() === row.to_game.toLowerCase()) {
        throw new AuthError(
          409,
          "That's a credit-in, not a transfer — correct it from the free credit or referral bonus it pays",
        );
      }
      // Manual rows are created completed and only this route moves them to
      // failed. Anything else is a state this route doesn't know how to unwind.
      if (row.status !== "completed" && row.status !== "failed") {
        throw new AuthError(409, `Transfer is ${row.status} — it can't be edited until it finishes`);
      }

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

      // Canonical spelling before anything is compared or stored, as at POST.
      const oldFrom = await canonicalise(row.from_game, txn);
      const oldTo = await canonicalise(row.to_game, txn);
      const newFrom = body.from_game !== undefined ? await canonicalise(body.from_game, txn) : oldFrom;
      const newTo = body.to_game !== undefined ? await canonicalise(body.to_game, txn) : oldTo;
      if (newFrom.toLowerCase() === newTo.toLowerCase()) {
        throw new AuthError(400, "From and to game must differ");
      }

      const oldFromLogin = resolveGameLogin(oldPlayer.game_accounts, oldFrom, row.from_game_username);
      const oldToLogin = resolveGameLogin(oldPlayer.game_accounts, oldTo, row.to_game_username);
      /**
       * Each login follows the request, else the row — unless the member or
       * that end's game moved, in which case the old login belongs to someone
       * or something else and the new pair's first account is the default.
       */
      const loginFor = (
        explicit: string | null | undefined,
        game: string,
        oldGame: string,
        oldLogin: string,
      ) =>
        explicit !== undefined
          ? resolveGameLogin(newPlayer.game_accounts, game, explicit)
          : playerChanged || game.toLowerCase() !== oldGame.toLowerCase()
            ? resolveGameLogin(newPlayer.game_accounts, game, null)
            : oldLogin;
      const newFromLogin = loginFor(body.from_game_username, newFrom, oldFrom, oldFromLogin);
      const newToLogin = loginFor(body.to_game_username, newTo, oldTo, oldToLogin);
      for (const [game, login, oldGame, oldLogin] of [
        [newFrom, newFromLogin, oldFrom, oldFromLogin],
        [newTo, newToLogin, oldTo, oldToLogin],
      ] as const) {
        const moved =
          playerChanged ||
          game.toLowerCase() !== oldGame.toLowerCase() ||
          login.toLowerCase() !== oldLogin.toLowerCase();
        if (moved && !holdsGameLogin(newPlayer.game_accounts, game, login)) {
          throw new AuthError(
            422,
            `${newPlayer.username} has no ${game} login${login ? ` "${login}"` : ""}`,
          );
        }
      }

      const newAmount = body.amount ?? row.transfer_amount;
      const newStatus = body.status ?? row.status;
      const newNote = body.note !== undefined ? (body.note?.trim() || null) : row.note;
      // Same instant in another spelling is not an edit.
      const newCreatedAt =
        body.created_at !== undefined && Date.parse(body.created_at) !== Date.parse(row.created_at)
          ? body.created_at
          : row.created_at;

      const wasBooked = row.status === "completed";
      const willBeBooked = newStatus === "completed";
      const bookingChanged =
        wasBooked !== willBeBooked ||
        (willBeBooked &&
          (playerChanged ||
            newPlayer.company_entity_id !== oldPlayer.company_entity_id ||
            newFrom.toLowerCase() !== oldFrom.toLowerCase() ||
            newTo.toLowerCase() !== oldTo.toLowerCase() ||
            newFromLogin.toLowerCase() !== oldFromLogin.toLowerCase() ||
            newToLogin.toLowerCase() !== oldToLogin.toLowerCase() ||
            newAmount !== row.transfer_amount));

      const nowIso = new Date().toISOString();
      let negativeWallets: Array<{ game: string; login: string; balance: number }> = [];
      if (bookingChanged) {
        const legs: CreditLeg[] = [];
        if (wasBooked) {
          const amt = row.transfer_amount;
          const co = oldPlayer.company_entity_id;
          const pid = oldPlayer.player_id;
          legs.push(
            { kind: "wallet", playerId: pid, gameName: oldFrom, login: oldFromLogin, delta: amt },
            { kind: "wallet", playerId: pid, gameName: oldTo, login: oldToLogin, delta: -amt },
            { kind: "kiosk", companyEntityId: co, gameName: oldFrom, delta: -amt },
            { kind: "kiosk", companyEntityId: co, gameName: oldTo, delta: amt },
          );
        }
        if (willBeBooked) {
          const co = newPlayer.company_entity_id;
          const pid = newPlayer.player_id;
          legs.push(
            { kind: "wallet", playerId: pid, gameName: newFrom, login: newFromLogin, delta: -newAmount },
            { kind: "wallet", playerId: pid, gameName: newTo, login: newToLogin, delta: newAmount },
            { kind: "kiosk", companyEntityId: co, gameName: newFrom, delta: newAmount },
            { kind: "kiosk", companyEntityId: co, gameName: newTo, delta: -newAmount },
          );
        }
        ({ negativeWallets } = await applyCreditRebook(txn, legs, nowIso));
      }

      const before = {
        player_username: oldPlayer.username,
        from_game: oldFrom,
        from_game_username: oldFromLogin,
        to_game: oldTo,
        to_game_username: oldToLogin,
        transfer_amount: row.transfer_amount,
        status: row.status,
        note: row.note,
        created_at: row.created_at,
      };
      const after = {
        player_username: newPlayer.username,
        from_game: newFrom,
        from_game_username: newFromLogin,
        to_game: newTo,
        to_game_username: newToLogin,
        transfer_amount: newAmount,
        status: newStatus,
        note: newNote,
        created_at: newCreatedAt,
      };
      const changes = diffFields(before, after);
      if (!changes.length) {
        return { row, saved: row, before, changes, negativeWallets, player: newPlayer };
      }

      const [saved] = await txn
        .update(gameTransfers)
        .set({
          player_id: newPlayer.player_id,
          from_game: newFrom,
          to_game: newTo,
          from_game_username: newFromLogin,
          to_game_username: newToLogin,
          transfer_amount: newAmount,
          status: newStatus,
          note: newNote,
          created_at: newCreatedAt,
          // A status change is a new terminal moment.
          ...(newStatus !== row.status ? { completed_at: nowIso } : {}),
        })
        .where(eq(gameTransfers.transfer_id, transferId))
        .returning();

      // amount = what the edit changed in the booked figure: the whole of it
      // on completed ↔ failed, the difference on a re-booked amount, 0 on a
      // text-only edit.
      const booked = (s: string, amt: number) => (s === "completed" ? amt : 0);
      await txn.insert(transactions).values({
        player_id: newPlayer.player_id,
        entity_id: newPlayer.company_entity_id,
        type: "game_transfer",
        amount: +(booked(newStatus, newAmount) - booked(row.status, row.transfer_amount)).toFixed(2),
        game_name: `${newFrom} → ${newTo}`,
        reference_id: transferId,
        user_id: user.user_id,
        details: {
          source: "manual",
          action:
            newStatus !== row.status
              ? newStatus === "failed"
                ? "reversed_manually"
                : "completed_manually"
              : "edited_manually",
          from: newFrom,
          to: newTo,
          rebooked: bookingChanged,
          before,
          after,
        },
      });

      return { row, saved, before, changes, negativeWallets, player: newPlayer };
    });

    if (result.changes.length) {
      await logActivity({
        category: "transaction",
        action: "game_transfer.edited",
        summary:
          `Game transfer #${result.saved.transfer_id} edited: ${result.player.username} — ` +
          describeChanges(result.changes),
        actor: user,
        companyEntityId: result.player.company_entity_id,
        targetType: "game_transfer",
        targetId: result.saved.transfer_id,
        targetLabel: `${result.saved.from_game} → ${result.saved.to_game}`,
        changes: result.changes,
        context: { before: result.before },
      });
    }

    return Response.json({
      transfer: result.saved,
      ...(result.negativeWallets.length
        ? {
            warning:
              `Saved, but a wallet is now below zero — ` +
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

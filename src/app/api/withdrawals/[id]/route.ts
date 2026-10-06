import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, players, transactions, withdrawals } from "@/db/schema";
import { canActOnClaim } from "@/lib/claims";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { assertNotArchived, jsonError } from "@/lib/api-helpers";
import { appendEditNote, describeChanges, diffFields, logActivity } from "@/lib/activity-log";
import { InsufficientBankBalanceError } from "@/lib/bank-balance";
import { canonicalise } from "@/lib/game-name";
import { holdsGameLogin, loginForGame } from "@/lib/game-credits";
import { InsufficientKioskCreditError } from "@/lib/kiosk-credit";
import { paysWithdrawals } from "@/lib/types";
import {
  bookManualPayout,
  bookManualPull,
  rebookPulledWithdrawal,
  reverseManualPayout,
  reverseManualPull,
  reverseManualWithdrawal,
} from "@/lib/withdrawal-pull";

type WithdrawalStatus = (typeof withdrawals.$inferSelect)["status"];

const patchSchema = z.object({
  // The member. Manual rows only — moving a pulled row re-books both wallets.
  player_id: z.number().int().positive().optional(),
  requested_amount: z.number().positive().optional(),
  // The Remark cell. Moves no money; blank clears it.
  remark: z.string().max(500).nullable().optional(),
  game_name: z.string().min(1).max(60).optional(),
  game_username: z.string().max(120).nullable().optional(),
  // The player's own account the money is paid into — a label, no money moves.
  bank_name: z.string().max(60).nullable().optional(),
  bank_account_number: z.string().max(60).nullable().optional(),
  // Which of OUR accounts paid it. Filling it on a pulled row pays the row;
  // changing it on a paid row moves the deduction to the new account.
  paid_from_account_id: z.number().int().positive().nullable().optional(),
  // Manual rows only. "requested" is not offered: a row is never un-pulled
  // back into the queue, it is failed and re-entered.
  status: z.enum(["credits_pulled", "paid", "failed"]).optional(),
  // The row's date/time on the sheet, for a row keyed after the fact.
  created_at: z.string().datetime({ offset: true }).optional(),
});

/**
 * Which statuses a manual row may be moved to, and from where.
 *
 * Every one of these is something CS can do by hand at the kiosk and the bank,
 * which is the whole test: a manual row is the desk's own record, so the desk
 * may say what happened. Nothing here waits on the agent, and nothing goes
 * back to "requested" — that state means "nobody has acted yet", which stops
 * being true the moment anybody has.
 */
const MANUAL_STATUS_FROM: Record<
  "credits_pulled" | "paid" | "failed",
  readonly WithdrawalStatus[]
> = {
  credits_pulled: ["requested", "paid", "failed"],
  paid: ["requested", "credits_pulled", "failed"],
  failed: ["requested", "credits_pulled", "paid"],
};

const isPulled = (s: WithdrawalStatus) => s === "credits_pulled" || s === "paid";

/**
 * PATCH /api/withdrawals/:id — correct a withdrawal, re-booking whatever it
 * already moved.
 *
 * A manual row is editable in every cell and at every stage, by anyone who can
 * write — the claim is not checked. It used to be: "only the holder may
 * correct a row" was meant to stop two desks fixing one figure in opposite
 * directions, but in practice it meant a mistake sat on the sheet until the
 * person holding the row came back. The row lock below is what actually stops
 * two corrections interleaving; the later one simply wins, and both are in
 * the log.
 *
 * Correcting a row that has already moved money is a re-booking, not a
 * relabel. The withdrawal books in two layers, and each is undone and laid
 * down again only if the edit touches it:
 *
 *   - the pull: the player's wallet down, the company's kiosk float up
 *     (game, login, amount, member);
 *   - the payout: the paying bank account down, the member's
 *     total_withdrawals up (amount, member, Paid From).
 *
 * So moving a payout to another account touches only the two bank balances,
 * and correcting a figure on a paid row refunds the old payout, re-books the
 * pull by the difference, and pays the new figure — all in one transaction,
 * so a half-done correction can't commit.
 *
 * A row the agent handled is the agent's record of what it did at the kiosk,
 * and stays as it was: correctable only while still "requested", and only in
 * the cells it always offered.
 *
 * Recorded as deposits are: the booking functions write their own ledger
 * rows, a `transactions` row notes the edit for the History page, and one
 * activity_log entry carries the before/after diff.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const withdrawalId = Number((await params).id);
    if (!Number.isInteger(withdrawalId)) return jsonError("Bad withdrawal id");

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid payload");
    }
    const body = parsed.data;

    // Through the catalogue, so an edit cannot introduce a spelling the rest
    // of the system does not recognise.
    const gameName =
      body.game_name !== undefined ? await canonicalise(body.game_name) : undefined;

    const result = await db.transaction(async (txn) => {
      /**
       * Locked before anything is read off it. Two people correcting the same
       * row at once would otherwise both reverse the same booking, and the
       * second reversal would refund money the first already gave back.
       */
      const [row] = await txn
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .for("update");
      if (!row) throw new AuthError(404, "Withdrawal not found");

      const [player] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, row.player_id));
      if (!player) throw new AuthError(404, "Player not found");
      if (user.companyIds !== null && !user.companyIds.includes(player.company_entity_id)) {
        throw new AuthError(403, "Withdrawal is outside your company scope");
      }

      const manual = !!row.skip_bot;
      if (!manual) {
        if (row.status !== "requested") {
          throw new AuthError(
            409,
            row.status === "credits_pulled"
              ? "The agent pulled that one — only manual rows can be corrected here"
              : `Withdrawal is already ${row.status} — only manual rows can be corrected now`,
          );
        }
        if (
          body.status !== undefined ||
          body.paid_from_account_id !== undefined ||
          body.player_id !== undefined ||
          body.created_at !== undefined
        ) {
          throw new AuthError(
            409,
            "That's an agent withdrawal — its member, status, payout and date are the agent's",
          );
        }
      }

      // The member, when the edit moves the row to someone else.
      let nextPlayer = player;
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
        nextPlayer = p;
      }
      const playerChanged = nextPlayer.player_id !== row.player_id;

      /**
       * The paying account must be one of the member's company's, and one that
       * pays out — the same question POST /:id/paid asks. Re-asked when the
       * member moves, because the account that paid the old member's company
       * is not the new one's.
       */
      const nextPaidFrom =
        body.paid_from_account_id !== undefined
          ? body.paid_from_account_id
          : row.paid_from_account_id;
      const accountChanged = nextPaidFrom !== row.paid_from_account_id;
      if (nextPaidFrom !== null && (accountChanged || playerChanged)) {
        const [account] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, nextPaidFrom));
        if (!account) throw new AuthError(404, "Payout account not found");
        if (account.entity_id !== nextPlayer.company_entity_id) {
          throw new AuthError(403, "That account belongs to another company");
        }
        if (!paysWithdrawals(account.role)) {
          throw new AuthError(422, "Payouts must come from a withdrawal-role account");
        }
      }

      /**
       * Where the row ends up.
       *
       * Filling Paid From on a pulled row is CS saying which account the money
       * left — that is the row being paid, and asking them to also flip the
       * status would be asking twice. Clearing it on a paid row is ambiguous
       * (un-pay it, or just a slip?), so that one has to be said explicitly.
       */
      let nextStatus: WithdrawalStatus = body.status ?? row.status;
      if (
        body.status === undefined &&
        manual &&
        row.status === "credits_pulled" &&
        body.paid_from_account_id != null
      ) {
        nextStatus = "paid";
      }
      if (
        body.status === undefined &&
        row.status === "paid" &&
        body.paid_from_account_id === null
      ) {
        throw new AuthError(
          422,
          "A paid withdrawal needs Paid From — set the status to Credits Pulled to undo the payout",
        );
      }
      if (nextStatus !== row.status) {
        const from = MANUAL_STATUS_FROM[nextStatus as keyof typeof MANUAL_STATUS_FROM];
        if (!from || !from.includes(row.status)) {
          throw new AuthError(
            409,
            `A ${row.status} withdrawal can't be marked ${nextStatus} here`,
          );
        }
      }

      const wasPulled = isPulled(row.status);
      const willPull = isPulled(nextStatus);
      const wasPaid = row.status === "paid";
      const willPay = nextStatus === "paid";

      // On a pulled row the two figures are the same claim: CS pulled what
      // they typed. Leaving the pulled amount behind would pay the player one
      // number and account for another.
      const pulledAmount =
        body.requested_amount ??
        (row.credit_pulled_amount > 0 ? row.credit_pulled_amount : row.requested_amount);
      if (willPull && pulledAmount <= 0) {
        throw new AuthError(422, "Enter the amount that was pulled first");
      }
      const amountChanged = wasPulled && willPull && pulledAmount !== row.credit_pulled_amount;
      const gameChanged = gameName !== undefined && gameName !== row.game_name;
      // A game change on its own carries the login across — see loginForGame.
      if (gameChanged && body.game_username === undefined && row.game_username) {
        body.game_username = loginForGame(nextPlayer.game_accounts ?? null, gameName, row.game_username);
      }
      const loginChanged =
        body.game_username !== undefined && body.game_username !== row.game_username;

      /**
       * A named login has to be one the member actually has.
       *
       * The pull re-book credits back the login it came from and debits the
       * new one by what that login's cache holds — so a mistyped login would
       * refund the real wallet and take min(0, x) from a wallet that doesn't
       * exist, inventing credit. Asked whenever the game, login or member
       * moves, since each can strand the login on its own. Empty means "the
       * member's first account for the game", which always resolves.
       */
      if (gameChanged || loginChanged || playerChanged) {
        const login =
          body.game_username !== undefined ? body.game_username : row.game_username;
        const game = gameName ?? row.game_name;
        if (login && !holdsGameLogin(nextPlayer.game_accounts ?? null, game, login)) {
          throw new AuthError(
            422,
            `${login} isn't one of ${nextPlayer.username}'s ${game} logins`,
          );
        }
      }

      // Which layers this edit has to undo and lay down again.
      const pullTouched = amountChanged || playerChanged || gameChanged || loginChanged;
      const rebookPull = wasPulled && willPull && pullTouched && !playerChanged;
      const undoPull = wasPulled && (!willPull || (pullTouched && playerChanged));
      const layPull = willPull && (!wasPulled || (pullTouched && playerChanged));
      const undoPayout = wasPaid && (!willPay || amountChanged || playerChanged || accountChanged);
      const layPayout = willPay && (!wasPaid || undoPayout);
      // Asked only when a payout is being laid down. A row paid before Paid
      // From was required has none, and correcting its bank name shouldn't
      // demand one; correcting its amount re-pays it, and that does.
      if (layPayout && nextPaidFrom === null) {
        throw new AuthError(422, "Fill Paid From first");
      }

      const nowIso = new Date().toISOString();

      // Out with the old, newest layer first: the payout, then the pull.
      if (undoPayout) {
        // The total always comes back down; the bank only if one paid it.
        const { bankRepaid } = await reverseManualPayout(txn, { row });
        await txn.insert(transactions).values({
          player_id: row.player_id,
          entity_id: player.company_entity_id,
          type: "withdrawal",
          amount: -row.credit_pulled_amount,
          game_name: row.game_name,
          reference_id: row.withdrawal_id,
          user_id: user.user_id,
          details: {
            source: "manual",
            action: willPay ? "payout_reversed_for_rebook" : "payout_reversed",
            paid_from_account_id: row.paid_from_account_id,
            bank_repaid: bankRepaid,
            to_status: nextStatus,
          },
        });
      }
      if (undoPull) {
        const { walletReturned } = await reverseManualPull(txn, { row, player, nowIso });
        await txn.insert(transactions).values({
          player_id: row.player_id,
          entity_id: player.company_entity_id,
          type: "credit_pull",
          amount: -row.credit_pulled_amount,
          game_name: row.game_name,
          reference_id: row.withdrawal_id,
          user_id: user.user_id,
          details: {
            source: "manual",
            action: willPull ? "pull_reversed_for_rebook" : "pull_reversed",
            wallet_returned: walletReturned,
            // Nothing is debited any more. reverseManualPull reads the latest
            // credit_pull row to learn what is, so this has to say so.
            wallet_debited: 0,
            to_status: nextStatus,
          },
        });
      }

      /**
       * The row itself. A layer about to be laid down again sets its own
       * status (bookManualPull → credits_pulled, bookManualPayout → paid), so
       * the row is left one step short of it here. paid_at survives a re-laid
       * payout — the cash left the bank when it left — and goes when the
       * payout is undone for good.
       */
      const statusNow: WithdrawalStatus = !willPull
        ? nextStatus
        : willPay && !layPayout
          ? "paid"
          : "credits_pulled";
      const [patched] = await txn
        .update(withdrawals)
        .set({
          ...(playerChanged ? { player_id: nextPlayer.player_id } : {}),
          ...(body.requested_amount !== undefined
            ? { requested_amount: body.requested_amount }
            : {}),
          ...(willPull ? { credit_pulled_amount: pulledAmount } : {}),
          ...(gameName !== undefined ? { game_name: gameName } : {}),
          ...(body.game_username !== undefined ? { game_username: body.game_username } : {}),
          ...(body.bank_name !== undefined ? { bank_name: body.bank_name } : {}),
          ...(body.remark !== undefined ? { remark: body.remark?.trim() || null } : {}),
          ...(body.bank_account_number !== undefined
            ? { bank_account_number: body.bank_account_number }
            : {}),
          ...(body.paid_from_account_id !== undefined
            ? { paid_from_account_id: body.paid_from_account_id }
            : {}),
          ...(body.created_at !== undefined ? { created_at: body.created_at } : {}),
          status: statusNow,
          ...(willPay ? {} : { paid_at: null }),
          ...(nextStatus !== row.status ? { handled_by_user_id: user.user_id } : {}),
          updated_at: nowIso,
        })
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .returning();
      let saved = patched;

      // In with the new: the pull, then the payout on top of it.
      if (rebookPull) {
        await rebookPulledWithdrawal(txn, {
          before: row,
          after: saved,
          player: nextPlayer,
          userId: user.user_id,
        });
      }
      if (layPull) {
        saved = await bookManualPull(txn, {
          row: saved,
          player: nextPlayer,
          pulled: pulledAmount,
          userId: user.user_id,
          nowIso,
          action: wasPulled ? "repulled_after_edit" : "pulled_on_status_change",
        });
      }
      if (layPayout) {
        saved = await bookManualPayout(txn, {
          row: saved,
          player: nextPlayer,
          userId: user.user_id,
          nowIso,
          action: wasPaid ? "repaid_after_edit" : "paid_on_status_change",
        });
      }

      // Failing a row that never moved anything is the reject button by
      // another route; the ledger says so the same way.
      if (nextStatus === "failed" && row.status !== "failed") {
        await txn.insert(transactions).values({
          player_id: row.player_id,
          entity_id: player.company_entity_id,
          type: "withdrawal",
          amount: row.requested_amount,
          game_name: row.game_name,
          reference_id: row.withdrawal_id,
          user_id: user.user_id,
          details: { source: "manual", action: "rejected", from: row.status },
        });
      }

      return { row, player, nextPlayer, updated: saved };
    });

    const { row, player, nextPlayer, updated } = result;

    // "AMBANK 2 → CIMB 1" reads in the log; two account ids don't.
    const accountIds = [row.paid_from_account_id, updated.paid_from_account_id].filter(
      (id): id is number => id !== null,
    );
    const accounts = accountIds.length
      ? await db.select().from(bankAccounts).where(inArray(bankAccounts.account_id, accountIds))
      : [];
    const labelOf = (id: number | null) => {
      const a = accounts.find((x) => x.account_id === id);
      return a ? a.label?.trim() || `${a.bank_name} ${a.account_number}` : null;
    };

    const changes = diffFields(
      {
        player_username: player.username,
        requested_amount: row.requested_amount,
        credit_pulled_amount: row.credit_pulled_amount,
        game_name: row.game_name,
        game_username: row.game_username,
        bank_name: row.bank_name,
        bank_account_number: row.bank_account_number,
        paid_from: labelOf(row.paid_from_account_id),
        status: row.status,
        remark: row.remark,
        created_at: row.created_at,
      },
      {
        player_username: nextPlayer.username,
        requested_amount: updated.requested_amount,
        credit_pulled_amount: updated.credit_pulled_amount,
        game_name: updated.game_name,
        game_username: updated.game_username,
        bank_name: updated.bank_name,
        bank_account_number: updated.bank_account_number,
        paid_from: labelOf(updated.paid_from_account_id),
        status: updated.status,
        remark: updated.remark,
        created_at: updated.created_at,
      },
    );
    const trailChanges = changes.filter((c) => c.field !== "remark");

    if (changes.length) {
      // amount = 0: this row only notes the edit. Whatever money it moved is
      // on the pull/payout rows the re-booking wrote alongside it.
      await db.insert(transactions).values({
        player_id: updated.player_id,
        entity_id: nextPlayer.company_entity_id,
        type: "withdrawal",
        amount: 0,
        game_name: updated.game_name,
        reference_id: withdrawalId,
        user_id: user.user_id,
        details: {
          action: "edited",
          changes: changes.map((c) => ({ field: c.field, from: c.from, to: c.to })),
        },
      });
      await logActivity({
        category: "transaction",
        action: "withdrawal.edited",
        summary: `Withdrawal WD-${withdrawalId} edited — ${describeChanges(changes)}`,
        actor: user,
        companyEntityId: nextPlayer.company_entity_id,
        targetType: "withdrawal",
        targetId: withdrawalId,
        targetLabel: `WD-${withdrawalId}`,
        changes,
      });
      // …and on the row, which is where the sheet asks the question.
      const [withNote] = await db
        .update(withdrawals)
        .set({
          // The trail shares the Remark cell; a remark edit is the cell
          // itself, so it is logged but not echoed into the trail.
          edit_note: trailChanges.length
            ? appendEditNote(row.edit_note, user, trailChanges)
            : row.edit_note,
        })
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .returning();
      return Response.json({ withdrawal: withNote ?? updated });
    }

    return Response.json({ withdrawal: updated });
  } catch (e) {
    if (e instanceof InsufficientKioskCreditError) return jsonError(e.message, 422);
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/**
 * DELETE /api/withdrawals/:id — remove a row keyed wrong, giving back whatever
 * it moved: the bank repaid, the float's credit taken back off it, the
 * member's wallet and total_withdrawals restored.
 *
 * Gated like the deposit delete — own company, not held by someone else, and
 * manual rows only, because a row the agent pulled is the agent's record of
 * credit that really left the kiosk.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const withdrawalId = Number((await params).id);

    const row = await db.transaction(async (txn) => {
      const [wd] = await txn
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.withdrawal_id, withdrawalId))
        .for("update");
      if (!wd) throw new AuthError(404, "Withdrawal not found");

      const [player] = await txn
        .select()
        .from(players)
        .where(eq(players.player_id, wd.player_id));
      if (!player) throw new AuthError(404, "Player not found");
      if (user.companyIds !== null && !user.companyIds.includes(player.company_entity_id)) {
        throw new AuthError(403, "Withdrawal is outside your company scope");
      }
      // Held by the person deleting it (or a company leader) — see the deposit
      // delete for why a delete demands the claim where an edit does not.
      if (!canActOnClaim(user, wd.assigned_to_user_id)) {
        throw new AuthError(
          409,
          wd.assigned_to_user_id === null
            ? "Assign the row to yourself before deleting it"
            : "That row is assigned to someone else — they have to release it first",
        );
      }
      if (!wd.skip_bot) {
        throw new AuthError(
          409,
          "That withdrawal was handled by the agent — only manual rows can be deleted here",
        );
      }

      await reverseManualWithdrawal(txn, { row: wd, player, userId: user.user_id });

      await txn.insert(transactions).values({
        player_id: wd.player_id,
        entity_id: player.company_entity_id,
        type: "withdrawal",
        amount: -wd.credit_pulled_amount,
        game_name: wd.game_name,
        user_id: user.user_id,
        details: {
          source: "manual",
          action: "withdrawal_deleted",
          withdrawal_id: wd.withdrawal_id,
          player_username: player.username,
          requested: wd.requested_amount,
          pulled: wd.credit_pulled_amount,
          paid_from_account_id: wd.paid_from_account_id,
          status_before: wd.status,
          // Which row, when two on one shift are otherwise identical.
          requested_at: wd.created_at,
        },
      });

      await txn.delete(withdrawals).where(eq(withdrawals.withdrawal_id, withdrawalId));
      return { wd, player };
    });

    await logActivity({
      category: "transaction",
      action: "withdrawal.deleted",
      summary:
        `Withdrawal deleted: ${row.player.username} — ` +
        `RM ${row.wd.credit_pulled_amount.toFixed(2)} ${row.wd.game_name} ` +
        `requested ${row.wd.created_at} (was ${row.wd.status})`,
      actor: user,
      companyEntityId: row.player.company_entity_id,
      targetType: "withdrawal",
      targetId: row.wd.withdrawal_id,
      targetLabel: row.player.username,
      context: {
        requested: row.wd.requested_amount,
        pulled: row.wd.credit_pulled_amount,
        game: row.wd.game_name,
        paid_from_account_id: row.wd.paid_from_account_id,
        requested_at: row.wd.created_at,
        status_before: row.wd.status,
      },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

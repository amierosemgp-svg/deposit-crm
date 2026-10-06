import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts, deposits, players, referralBonuses, transactions } from "@/db/schema";
import { canActOnClaim } from "@/lib/claims";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { canOverrideEligibility, resolveBonusForDeposit } from "@/lib/bonus";
import { InsufficientBankBalanceError } from "@/lib/bank-balance";
import { bonusOn } from "@/lib/bonus-math";
import {
  completeManualDeposit,
  rebookCompletedDeposit,
  reverseCompletedDeposit,
  syncCutoffForCompletion,
} from "@/lib/deposit-complete";
import { InsufficientKioskCreditError } from "@/lib/kiosk-credit";
import { syncReferralBonus } from "@/lib/referral";
import { canonicalise } from "@/lib/game-name";
import { holdsGameLogin, loginForGame } from "@/lib/game-credits";
import {
  appendEditNote,
  describeChanges,
  diffFields,
  logActivity,
} from "@/lib/activity-log";

type DepositStatus = (typeof deposits.$inferSelect)["status"];

const patchSchema = z.object({
  // The bonus to apply; null clears it back to no bonus.
  bonus_plan_id: z.number().int().positive().nullable().optional(),
  // The old free-percentage path, still honoured when no plan is named.
  bonus_percentage: z.number().min(0).max(200).optional(),
  // Leaders/admins only: force a bonus the player isn't entitled to, on record.
  bonus_override_reason: z.string().max(200).optional(),
  selected_game: z.string().nullable().optional(),
  player_id: z.number().int().positive().optional(), // the member; also assigns an unmatched bot deposit
  // The rest of a worksheet row. On a row still in flight nothing has moved,
  // so a correction costs nothing to undo; on a completed manual row the
  // booking is unwound and laid down again below.
  deposit_amount: z.number().positive().optional(),
  bank_name: z.string().min(1).max(60).optional(),
  // Which of our accounts the money landed in — the one whose balance moves.
  received_into_account_id: z.number().int().positive().optional(),
  selected_game_username: z.string().max(120).nullable().optional(),
  // The Remark cell. Moves no money; blank clears it.
  remark: z.string().max(500).nullable().optional(),
  deposit_date: z.string().datetime({ offset: true }).optional(),
  // False when the sheet only knows the day. Defaults to true whenever a
  // deposit_date is sent, as it always has.
  deposit_time_known: z.boolean().optional(),
  // Manual rows only — see MANUAL_STATUS_FROM.
  status: z.enum(["completed", "failed"]).optional(),
});

/**
 * Which statuses a manual deposit may be moved to, and from where.
 *
 * A manual row is the desk's own record of something done by hand at the bank
 * and the kiosk, so the desk may say it happened (completed) or didn't
 * (failed) — and change its mind, which is the case this exists for: a row
 * failed by mistake, or completed against a transfer that bounced. Moving it
 * back into the queue (pending, approved, processing) is not offered; those
 * states mean "waiting on someone", and on a manual row nobody is waiting.
 */
const MANUAL_STATUS_FROM: Record<"completed" | "failed", readonly DepositStatus[]> = {
  completed: ["pending", "matched", "processing", "failed"],
  failed: ["pending", "matched", "processing", "completed"],
};

/**
 * PATCH /api/deposits/:id — correct a deposit, re-booking whatever it already
 * moved.
 *
 * A manual row is editable in every cell, at every stage, by anyone who can
 * write — the claim is no longer checked. "Only the holder may correct it" was
 * meant to stop two desks fixing one figure in opposite directions; what it did
 * in practice was leave a wrong figure on the sheet until the holder came back.
 * The row lock below is what actually keeps two corrections from interleaving:
 * the later one waits, then applies on top, and both are in the log.
 *
 * What an edit does to the money depends on where the row is and where it is
 * going:
 *
 *   - in flight → in flight: nothing has moved; the row is just corrected.
 *   - completed → completed: the old booking is unwound and the new one laid
 *     down, netted (rebookCompletedDeposit).
 *   - completed → failed: the booking is unwound completely
 *     (reverseCompletedDeposit), as a delete would — but the row stays.
 *   - anything → completed: booked exactly as the Complete button books it
 *     (completeManualDeposit), with the corrected values.
 *
 * A row the agent completed is not editable: its booking is the agent's own
 * record of what it did at the provider, and rewriting it here would leave the
 * CRM claiming something the kiosk never saw. Same for an agent row that
 * failed, and for an agent row's status, which is the agent's to drive.
 *
 * Every change is recorded twice on purpose: a `transactions` row per kind of
 * change, which is what the History page reads, and one activity_log entry
 * carrying the whole before/after diff, which is what answers "who changed
 * this, and what did it say before". The booking functions add their own
 * ledger rows for the money.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const depositId = Number(id);
    if (!Number.isInteger(depositId)) return jsonError("Bad deposit id");

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const body = parsed.data;

    /**
     * The read, the checks, the correction and its re-booking all happen
     * under one lock and commit together. Half of this — a row that says
     * RM 50 over credit of RM 550 — is worse than either outcome, and two
     * corrections reading the same "before" would each unwind the same
     * booking.
     */
    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(deposits)
        .where(eq(deposits.deposit_id, depositId))
        .for("update");
      if (!row) throw new AuthError(404, "Deposit not found");
      if (
        user.companyIds !== null &&
        row.company_entity_id !== null &&
        !user.companyIds.includes(row.company_entity_id)
      ) {
        throw new AuthError(403, "Deposit is outside your company scope");
      }

      const manual = !!row.skip_bot;
      if (!manual) {
        if (row.status === "completed") {
          throw new AuthError(
            409,
            "That deposit was completed by the agent — only manual rows can be corrected here",
          );
        }
        if (row.status === "failed") throw new AuthError(409, "Deposit is already failed");
        if (body.status !== undefined) {
          throw new AuthError(409, "That's an auto deposit — its status is the agent's to set");
        }
        /**
         * An auto row's amount and bank are what the bank statement said.
         *
         * The agent matched the row off a real credit into a real account;
         * typing a different figure or account over it would leave the CRM
         * disagreeing with the statement it was read from. Player, game and
         * bonus stay open — those are CS's to decide.
         */
        if (
          body.deposit_amount !== undefined ||
          body.bank_name !== undefined ||
          body.received_into_account_id !== undefined
        ) {
          throw new AuthError(
            409,
            "That's an auto deposit — its amount and bank come from the bank statement and can't be edited",
          );
        }
      }

      const nextStatus: DepositStatus = body.status ?? row.status;
      const statusChanged = nextStatus !== row.status;
      if (statusChanged) {
        const from = MANUAL_STATUS_FROM[nextStatus as keyof typeof MANUAL_STATUS_FROM];
        if (!from.includes(row.status)) {
          throw new AuthError(409, `A ${row.status} deposit can't be marked ${nextStatus} here`);
        }
      }
      const wasBooked = row.status === "completed";
      const willBook = nextStatus === "completed";

      let playerPatch = {};
      let playerId = row.player_id;
      let companyEntityId = row.company_entity_id;
      if (body.player_id !== undefined) {
        const [player] = await txn
          .select()
          .from(players)
          .where(eq(players.player_id, body.player_id));
        if (!player) throw new AuthError(404, "Player not found");
        if (
          user.companyIds !== null &&
          !user.companyIds.includes(player.company_entity_id)
        ) {
          throw new AuthError(403, "Player is outside your company scope");
        }
        playerPatch = {
          player_id: player.player_id,
          player_username: player.username,
          company_entity_id: player.company_entity_id,
        };
        playerId = player.player_id;
        companyEntityId = player.company_entity_id;
      }

      // A bare percentage means "no plan" — it's the ad-hoc path, so naming one
      // clears whatever plan the row was carrying.
      const touchesBonus =
        body.bonus_plan_id !== undefined || body.bonus_percentage !== undefined;
      // Re-assigning the player invalidates a plan that was checked against the
      // previous one: the new player may already have had the welcome bonus.
      const playerChanged =
        body.player_id !== undefined && body.player_id !== row.player_id;
      /**
       * A new amount re-checks a plan too, not just its arithmetic: plans
       * carry minimums, caps and rebate bases, and a bonus that was fine on
       * RM 500 may not exist on RM 50. An ad-hoc percentage has nothing to
       * check and is simply rebased below.
       */
      const nextAmount = body.deposit_amount ?? row.deposit_amount;
      const amountChanged = nextAmount !== row.deposit_amount;
      const recheckBonus =
        touchesBonus || ((playerChanged || amountChanged) && !!row.bonus_plan_id);

      let bonusPatch: Record<string, unknown> = {};
      let bonusNote: Record<string, unknown> | null = null;

      if (recheckBonus) {
        const wantedPlanId = touchesBonus
          ? (body.bonus_plan_id ?? null)
          : row.bonus_plan_id;

        if (wantedPlanId !== null && playerId === null) {
          throw new AuthError(422, "Assign a player before picking a bonus");
        }

        const resolved =
          playerId === null
            ? null
            : await resolveBonusForDeposit({
                planId: wantedPlanId,
                // Clearing the bonus means clearing it: only carry the row's old
                // percentage forward when this request isn't the one removing it.
                fallbackPercentage:
                  body.bonus_percentage ??
                  (body.bonus_plan_id === null ? 0 : row.bonus_percentage),
                ctx: {
                  playerId,
                  companyEntityId,
                  depositAmount: nextAmount,
                  // The row being edited is not its own competition.
                  excludeDepositId: depositId,
                },
                override: {
                  allowed:
                    canOverrideEligibility(user.role) &&
                    !!body.bonus_override_reason,
                  reason: body.bonus_override_reason,
                },
              });

        if (resolved && !resolved.ok) {
          // A bonus CS deliberately picked is worth an error. A bonus that only
          // stopped applying because the deposit changed hands, or its amount
          // was corrected, is not: the correction is the point of the request,
          // so the stale bonus is dropped and recorded rather than blocking it.
          if (touchesBonus) throw new AuthError(resolved.status, resolved.reason);
          bonusPatch = {
            bonus_plan_id: null,
            bonus_percentage: 0,
            bonus_amount: 0,
            bonus_basis_amount: null,
            bonus_override_reason: null,
            total_amount: nextAmount,
          };
          bonusNote = { action: "bonus_cleared", reason: resolved.reason };
        } else if (resolved?.ok) {
          bonusPatch = resolved.fields;
          bonusNote = {
            action: "bonus_changed",
            from: row.bonus_percentage,
            to: resolved.fields.bonus_percentage,
            bonus: resolved.plan?.name ?? null,
            bonus_plan_id: resolved.fields.bonus_plan_id,
            bonus_amount: resolved.fields.bonus_amount,
            ...(resolved.fields.bonus_override_reason
              ? { bonus_override_reason: resolved.fields.bonus_override_reason }
              : {}),
          };
        }
      }

      /**
       * A new bank account moves the money with it.
       *
       * The account id is what a completion credits; the name alone was only a
       * label, so changing it used to leave the money in the old account.
       */
      let bankPatch: Record<string, unknown> = {};
      // For the edit note: "AMBANK 2 → CIMB 1" reads; two account ids don't.
      let accountMove: { from: string | null; to: string } | null = null;
      if (
        body.received_into_account_id !== undefined &&
        body.received_into_account_id !== row.received_into_account_id
      ) {
        const [account] = await txn
          .select()
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, body.received_into_account_id));
        if (!account) throw new AuthError(404, "Bank account not found");
        if (companyEntityId !== null && account.entity_id !== companyEntityId) {
          throw new AuthError(403, "That account belongs to another company");
        }
        bankPatch = { received_into_account_id: account.account_id, bank_name: account.bank_name };
        const labelOf = (a: typeof account) => a.label?.trim() || `${a.bank_name} ${a.account_number}`;
        const [old] =
          row.received_into_account_id === null
            ? []
            : await txn
                .select()
                .from(bankAccounts)
                .where(eq(bankAccounts.account_id, row.received_into_account_id));
        accountMove = { from: old ? labelOf(old) : null, to: labelOf(account) };
      } else if (body.bank_name !== undefined) {
        bankPatch = { bank_name: body.bank_name };
      }

      /**
       * Moving the deposit to a member of another company moves it out of the
       * company whose bank took the money. The account it landed in has to
       * come along — named again in this request, from the new company — or
       * the re-booking would credit one company's bank for another's deposit.
       */
      if (
        companyEntityId !== row.company_entity_id &&
        companyEntityId !== null &&
        !("received_into_account_id" in bankPatch) &&
        row.received_into_account_id !== null
      ) {
        const [current] = await txn
          .select({ entity_id: bankAccounts.entity_id })
          .from(bankAccounts)
          .where(eq(bankAccounts.account_id, row.received_into_account_id));
        if (!current || current.entity_id !== companyEntityId) {
          throw new AuthError(
            422,
            "That member is in another company — pick the bank account the money landed in for that company",
          );
        }
      }

      /**
       * A new amount re-bases the bonus.
       *
       * The percentage is what CS chose; the cash figure follows from it. Left
       * alone, correcting 500 to 50 would keep a bonus struck on the larger
       * number and the deposit would credit more than it took in.
       */
      let amountPatch = {};
      if (amountChanged && "total_amount" in bonusPatch) {
        // The bonus was just resolved on the new amount; its figures stand.
        amountPatch = { deposit_amount: nextAmount };
      } else if (body.deposit_amount !== undefined && amountChanged) {
        const pct =
          (bonusPatch as { bonus_percentage?: number }).bonus_percentage ??
          row.bonus_percentage;
        const bonus = bonusOn(body.deposit_amount, pct);
        amountPatch = {
          deposit_amount: body.deposit_amount,
          bonus_amount: bonus,
          total_amount: +(body.deposit_amount + bonus).toFixed(2),
        };
      }

      const nextGame =
        body.selected_game !== undefined ? body.selected_game : row.selected_game;

      // A game change on its own carries the login across to the new game —
      // see loginForGame.
      if (
        body.selected_game !== undefined &&
        body.selected_game !== row.selected_game &&
        body.selected_game_username === undefined &&
        row.selected_game_username &&
        nextGame &&
        playerId !== null
      ) {
        const [holder] = await txn
          .select({ game_accounts: players.game_accounts })
          .from(players)
          .where(eq(players.player_id, playerId));
        body.selected_game_username = loginForGame(
          holder?.game_accounts ?? null,
          await canonicalise(nextGame, txn),
          row.selected_game_username,
        );
      }

      /**
       * A named login has to be one the member actually has.
       *
       * The re-booking takes the credit back off the old login and puts it on
       * the new one; a mistyped login would put real credit in a wallet that
       * doesn't exist (and, on the way back, take it from nowhere). Asked when
       * the game, login or member moves. Empty means "the member's first
       * account for the game", which always resolves.
       */
      const nextLogin =
        body.selected_game_username !== undefined
          ? body.selected_game_username
          : row.selected_game_username;
      if (
        nextLogin &&
        nextGame &&
        playerId !== null &&
        (playerChanged ||
          (body.selected_game !== undefined && body.selected_game !== row.selected_game) ||
          (body.selected_game_username !== undefined &&
            body.selected_game_username !== row.selected_game_username))
      ) {
        const [holder] = await txn
          .select({ username: players.username, game_accounts: players.game_accounts })
          .from(players)
          .where(eq(players.player_id, playerId));
        const game = await canonicalise(nextGame, txn);
        if (!holder || !holdsGameLogin(holder.game_accounts ?? null, game, nextLogin)) {
          throw new AuthError(
            422,
            `${nextLogin} isn't one of ${holder?.username ?? "the member"}'s ${game} logins`,
          );
        }
      }
      if (willBook && (!playerId || !nextGame)) {
        throw new AuthError(422, "A player and game are required to complete");
      }

      /**
       * A recommend bonus that has already been paid is somebody else's money
       * now. Failing the deposit it was earned on, or moving that deposit to
       * another member, would leave the upline paid for a deposit that no
       * longer counts — and clawing it back silently is worse than refusing.
       * Same rule as deleting the row.
       */
      if (wasBooked && (!willBook || playerChanged)) {
        const bonuses = await txn
          .select({ status: referralBonuses.status })
          .from(referralBonuses)
          .where(eq(referralBonuses.deposit_id, depositId));
        if (bonuses.some((b) => b.status === "assigned")) {
          throw new AuthError(
            409,
            "A recommend bonus on this deposit has already been paid — cancel that payout first",
          );
        }
      }

      const nowIso = new Date().toISOString();
      const patch = {
        ...playerPatch,
        ...bonusPatch,
        ...amountPatch,
        ...bankPatch,
        ...(body.selected_game_username !== undefined
          ? { selected_game_username: body.selected_game_username }
          : {}),
        ...(body.remark !== undefined ? { remark: body.remark?.trim() || null } : {}),
        ...(body.deposit_date !== undefined
          ? {
              deposit_date: body.deposit_date,
              deposit_time_known: body.deposit_time_known ?? true,
            }
          : body.deposit_time_known !== undefined
            ? { deposit_time_known: body.deposit_time_known }
            : {}),
        selected_game: nextGame,
        // Failing is stamped here; completing is stamped by the booking.
        ...(statusChanged && !willBook
          ? { status: nextStatus, handled_by_user_id: user.user_id }
          : {}),
        updated_at: nowIso,
      };

      let negativeWallets: Array<{ game: string; login: string; balance: number }> = [];

      // Read before the row is written: the write stamps updated_at, which is
      // the completion's default sync cutoff (see syncCutoffForCompletion).
      const syncCutoffIso =
        willBook && !wasBooked ? await syncCutoffForCompletion(txn, row) : undefined;

      // completed → failed: give back everything the completion booked, off the
      // row as it stood — that is what was booked, whatever the edit says now.
      if (wasBooked && !willBook) {
        const reversed = await reverseCompletedDeposit(txn, { row, nowIso });
        negativeWallets = reversed.negativeWallets;
        await txn.insert(transactions).values({
          player_id: row.player_id,
          entity_id: row.company_entity_id,
          type: "game_topup",
          amount: -row.total_amount,
          game_name: row.selected_game,
          reference_id: row.deposit_id,
          user_id: user.user_id,
          details: {
            source: "manual",
            action: "reversed_on_fail",
            amount: row.deposit_amount,
            bonus: row.bonus_amount,
            received_into_account_id: row.received_into_account_id,
            // Whether the wallet credit came back out. False when the
            // completion never wrote one (an agent sync had already counted
            // the top-up); re-completing reads this to keep skipping it.
            wallet_reversed: reversed.walletReversed,
            ...(negativeWallets.length ? { wallets_below_zero: negativeWallets } : {}),
          },
        });
      }

      const [patched] = await txn
        .update(deposits)
        .set(patch)
        .where(eq(deposits.deposit_id, depositId))
        .returning();
      let saved = patched;

      if (wasBooked && willBook) {
        // completed → completed: re-book only if the edit touched the money.
        const moved =
          saved.total_amount !== row.total_amount ||
          saved.deposit_amount !== row.deposit_amount ||
          saved.received_into_account_id !== row.received_into_account_id ||
          saved.selected_game !== row.selected_game ||
          saved.selected_game_username !== row.selected_game_username ||
          saved.player_id !== row.player_id;
        if (moved) {
          ({ negativeWallets } = await rebookCompletedDeposit(txn, {
            before: row,
            after: saved,
            userId: user.user_id,
            nowIso,
          }));
        }
      } else if (willBook) {
        // → completed: the same booking the Complete button does, on the
        // corrected row.
        saved = await completeManualDeposit(txn, {
          row: saved,
          userId: user.user_id,
          nowIso,
          syncCutoffIso,
        });
      } else if (statusChanged) {
        // In flight → failed: nothing was booked, so this is the reject button
        // by another route, and the ledger says so the same way.
        await txn.insert(transactions).values({
          player_id: row.player_id,
          entity_id: row.company_entity_id,
          type: "deposit",
          amount: row.deposit_amount,
          game_name: row.selected_game,
          reference_id: row.deposit_id,
          user_id: user.user_id,
          details: { source: "manual", action: "rejected", from: row.status },
        });
      }

      /**
       * The recommend bonus follows the booking. It is earned on a member's
       * first qualifying completed deposit, so a deposit that stops counting —
       * failed, moved to someone else, or re-bonused onto the welcome plan —
       * may re-point or cancel a pending one, and one that starts counting may
       * create it. syncReferralBonus never touches a paid bonus, and no-ops
       * when nothing should change.
       */
      if (wasBooked || willBook) {
        for (const pid of new Set([row.player_id, saved.player_id])) {
          if (pid !== null) await syncReferralBonus(txn, pid);
        }
      }

      return { row, updated: saved, negativeWallets, bonusPatch, bonusNote, accountMove };
    });

    const { row, updated, negativeWallets, bonusPatch, bonusNote, accountMove } = result;

    // A `transactions` row for each kind of edit that actually changed a
    // value. amount = 0: these note the edit; any money it moved is on the
    // booking rows written inside the transaction.
    const audits: (typeof transactions.$inferInsert)[] = [];
    const base = {
      player_id: updated.player_id,
      entity_id: updated.company_entity_id,
      type: "deposit" as const,
      amount: 0,
      reference_id: depositId,
      user_id: user.user_id,
    };
    if (body.player_id !== undefined && body.player_id !== row.player_id) {
      audits.push({
        ...base,
        details: {
          action: "player_assigned",
          player: updated.player_username,
          transaction_ref: row.transaction_ref,
        },
      });
    }
    if (
      bonusNote &&
      (bonusPatch.bonus_plan_id !== row.bonus_plan_id ||
        bonusPatch.bonus_percentage !== row.bonus_percentage)
    ) {
      audits.push({
        ...base,
        details: { ...bonusNote, transaction_ref: row.transaction_ref },
      });
    }
    if (
      body.selected_game !== undefined &&
      body.selected_game !== row.selected_game
    ) {
      audits.push({
        ...base,
        details: {
          action: "game_selected",
          from: row.selected_game,
          to: body.selected_game,
          transaction_ref: row.transaction_ref,
        },
      });
    }
    if (audits.length) await db.insert(transactions).values(audits);

    // The whole diff, in the one place built for it. `transactions` says what
    // kind of change happened; this says what the value was before, which is
    // the question actually asked when a figure looks wrong.
    const changes = diffFields(
      {
        deposit_amount: row.deposit_amount,
        bank_name: row.bank_name,
        bank_account: accountMove?.from,
        selected_game: row.selected_game,
        selected_game_username: row.selected_game_username,
        deposit_date: row.deposit_date,
        bonus_percentage: row.bonus_percentage,
        bonus_amount: row.bonus_amount,
        player_username: row.player_username,
        status: row.status,
        remark: row.remark,
      },
      {
        deposit_amount: updated.deposit_amount,
        bank_name: updated.bank_name,
        bank_account: accountMove?.to,
        selected_game: updated.selected_game,
        selected_game_username: updated.selected_game_username,
        deposit_date: updated.deposit_date,
        bonus_percentage: updated.bonus_percentage,
        bonus_amount: updated.bonus_amount,
        player_username: updated.player_username,
        status: updated.status,
        remark: updated.remark,
      },
    );
    const trailChanges = changes.filter((c) => c.field !== "remark");
    let edited = updated;
    if (changes.length) {
      await logActivity({
        category: "transaction",
        action: "deposit.edited",
        summary: `Deposit ${updated.transaction_ref} edited — ${describeChanges(changes)}`,
        actor: user,
        companyEntityId: updated.company_entity_id,
        targetType: "deposit",
        targetId: depositId,
        targetLabel: updated.transaction_ref,
        changes,
      });
      // The same sentence, on the row, because that is where it gets read.
      const [withNote] = await db
        .update(deposits)
        .set({
          // The trail shares the Remark cell; a remark edit is the cell
          // itself, so it is logged but not echoed into the trail.
          edit_note: trailChanges.length
            ? appendEditNote(row.edit_note, user, trailChanges)
            : row.edit_note,
        })
        .where(eq(deposits.deposit_id, depositId))
        .returning();
      edited = withNote ?? updated;
    }

    return Response.json({
      deposit: edited,
      ...(negativeWallets.length
        ? {
            warning:
              `Corrected, but the player has already spent some of it — ` +
              negativeWallets
                .map(
                  (w) =>
                    `${w.game}${w.login ? ` ${w.login}` : ""} is now ${w.balance.toFixed(2)}`,
                )
                .join(", ") +
              `. Sync the kiosk balance.`,
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof InsufficientKioskCreditError) return jsonError(e.message, 422);
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

/**
 * DELETE /api/deposits/:id — remove a row the desk keyed wrong, and put every
 * figure it moved back where it was.
 *
 * The case this exists for is mundane and constant: a mistyped amount, or the
 * same deposit entered twice by two people on the same shift. Until now the
 * only fix was an edit, which cannot express "this never happened" — a
 * duplicate left the bank, the float and the member's totals all counting it.
 *
 * Same three gates as correcting a row, for the same reasons:
 *   - inside the caller's company scope;
 *   - not held by someone else (two desks undoing one row is how a figure gets
 *     reversed twice);
 *   - manual only. A row the agent completed is the agent's record of what it
 *     did at the provider, and deleting it here would leave the CRM silent
 *     about credit that really moved.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const depositId = Number((await params).id);

    const result = await db.transaction(async (txn) => {
      const [row] = await txn
        .select()
        .from(deposits)
        .where(eq(deposits.deposit_id, depositId))
        .for("update");
      if (!row) throw new AuthError(404, "Deposit not found");
      if (
        user.companyIds !== null &&
        row.company_entity_id !== null &&
        !user.companyIds.includes(row.company_entity_id)
      ) {
        throw new AuthError(403, "Deposit is outside your company scope");
      }
      /**
       * Deleting takes the claim, not just the absence of someone else's.
       *
       * Editing tolerates an unheld row — two desks correcting one figure end
       * up with the later value and no harm done. A delete cannot be walked
       * back, and the case it exists for is a duplicate: two people clearing
       * "the extra one" at the same moment would take out both copies. So the
       * row must be held by the person removing it, which costs one keystroke
       * (⌘A) and makes the log say who owned it. A company leader may remove
       * a colleague's — still one person, and the log carries the leader.
       */
      if (!canActOnClaim(user, row.assigned_to_user_id)) {
        throw new AuthError(
          409,
          row.assigned_to_user_id === null
            ? "Assign the row to yourself before deleting it"
            : "That row is assigned to someone else — they have to release it first",
        );
      }
      if (!row.skip_bot) {
        throw new AuthError(
          409,
          "That deposit was handled by the agent — only manual rows can be deleted here",
        );
      }

      /**
       * A recommend bonus that has already been paid is somebody else's money
       * now. Clawing it back out of the upline silently is worse than refusing:
       * settle or cancel the payout first, then the deposit can go.
       */
      const bonuses = await txn
        .select()
        .from(referralBonuses)
        .where(eq(referralBonuses.deposit_id, depositId));
      if (bonuses.some((b) => b.status === "assigned")) {
        throw new AuthError(
          409,
          "A recommend bonus on this deposit has already been paid — cancel that payout first",
        );
      }

      // Only a completed row ever booked anything; pending and failed rows have
      // nothing to give back.
      const negativeWallets =
        row.status === "completed"
          ? (await reverseCompletedDeposit(txn, { row })).negativeWallets
          : [];

      // The bonus rows point at the deposit, so they go first.
      if (bonuses.length) {
        await txn.delete(referralBonuses).where(eq(referralBonuses.deposit_id, depositId));
      }

      await txn.insert(transactions).values({
        player_id: row.player_id,
        entity_id: row.company_entity_id,
        type: "game_topup",
        amount: -row.total_amount,
        game_name: row.selected_game,
        user_id: user.user_id,
        details: {
          source: "manual",
          action: "deposit_deleted",
          deposit_id: row.deposit_id,
          transaction_ref: row.transaction_ref,
          player_username: row.player_username,
          amount: row.deposit_amount,
          bonus: row.bonus_amount,
          bank: row.bank_name,
          received_into_account_id: row.received_into_account_id,
          status_before: row.status,
          // The row's own timestamp. Two deposits keyed twice on one shift are
          // identical in every other column, and telling them apart is exactly
          // what the log is for.
          deposit_date: row.deposit_date,
          ...(negativeWallets.length ? { wallets_below_zero: negativeWallets } : {}),
        },
      });

      await txn.delete(deposits).where(eq(deposits.deposit_id, depositId));
      return { row, negativeWallets };
    });

    await logActivity({
      category: "transaction",
      action: "deposit.deleted",
      summary:
        `Deposit deleted: ${result.row.player_username ?? "unmatched"} — ` +
        `RM ${result.row.deposit_amount.toFixed(2)} into ${result.row.bank_name} ` +
        `at ${result.row.deposit_date} (${result.row.transaction_ref})`,
      actor: user,
      companyEntityId: result.row.company_entity_id,
      targetType: "deposit",
      targetId: result.row.deposit_id,
      targetLabel: result.row.transaction_ref,
      context: {
        amount: result.row.deposit_amount,
        bonus: result.row.bonus_amount,
        bank: result.row.bank_name,
        game: result.row.selected_game,
        deposit_date: result.row.deposit_date,
        status_before: result.row.status,
      },
    });

    return Response.json({
      ok: true,
      ...(result.negativeWallets.length
        ? {
            warning:
              `Deleted, but the player had already spent some of it — ` +
              result.negativeWallets
                .map((w) => `${w.game}${w.login ? ` ${w.login}` : ""} is now ${w.balance.toFixed(2)}`)
                .join(", ") +
              `. Sync the kiosk balance.`,
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof InsufficientKioskCreditError) return jsonError(e.message, 422);
    if (e instanceof InsufficientBankBalanceError) return jsonError(e.message, 422);
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

-- The twenty player-name rows → leader transfers out, noted as CTC backup.
--
-- What the client said when we asked about them:
--
--     "Records with players name is direct transfer from your account to player
--      bank account as withdrawals. (is consider backup ctc)"
--
-- and, separately, that those people are players at ANOTHER company's casino, not
-- ours. Both halves matter:
--
--   * Money left a Pokercity account and paid out somebody's withdrawal. It is not
--     cash anybody walked out of a bank with, so `bank_cash_outs` is wrong — that is
--     only where the import parked it, because the sheet said product "Clear Bank".
--   * The payee is not our player, so `withdrawals` is also wrong. `player_id` is NOT
--     NULL and points at `players`, which holds Pokercity's members only. Writing
--     these there would mean inventing twenty players we do not have, or guessing —
--     and the names bear that out: four match no player at all, MARIATI matches three
--     and MOHD ASRAFF two, which is common-name collision, not identity.
--
-- What is left is what the client called it: company to company. Pokercity's money
-- settled another company's obligation, and `leader_transfers` is the sheet for a
-- settlement between two parties. Its `to_account_id` is nullable, which is the
-- reason this works where `bank_transfers` did not — that one requires both ends to
-- be accounts we hold, and we do not hold the far end. Here the far end is simply not
-- recorded, which is the truth, and the payee's name is kept verbatim in the note so
-- the row can be split by destination company later without going back to the sheet.
--
-- NO BALANCE MOVES. A positive cash-out contributes `-amount`; a leader transfer with
-- `from_account_id` set contributes `-amount`. Identical, per account, to the cent.
-- `current_balance` is deliberately not touched — the row is being re-filed, not
-- re-banked.
--
-- Both leader ends are ttt777, following the four rows the desk keyed by hand on 23
-- and 24 Sept. The receiving side is abclub77 — named in the note rather than in
-- `to_leader_user_id`, because no such user exists yet. If one is created later, these
-- rows can be repointed from the note; until then the note is the only record of who
-- the money settled with, so it is written the same way every time:
--
--     CTC backup to abclub77 - <PAYEE NAME AS THE SHEET WROTE IT>
--
-- Idempotent: guarded on `cash_out_relocations`. Reversible: the original row is kept
-- whole as jsonb. The count is asserted at 20, so if the desk adds or clears a row
-- before this runs it stops rather than sweeping up something it was not meant to.

DO $$
DECLARE
  v_batch constant varchar(60) := '2026-09-25-ctc-backup-players';
  v_ttt   constant int := 56;          -- users.username = 'ttt777'
  -- Everything in Clear Bank that is not one of the known non-player labels.
  v_skip  constant text := 'kalai|^/$|clear bank to mbb|ttt|^kc|website|cuci';
  r          record;
  new_id     int;
  n_found    int;
  n_transfer int := 0;
  n_rows     int := 0;
BEGIN

  SELECT count(*) INTO n_found
    FROM bank_cash_outs c
   WHERE c.reversed_at IS NULL AND c.amount > 0 AND c.taken_by !~* v_skip
     AND NOT EXISTS (SELECT 1 FROM cash_out_relocations x WHERE x.cash_out_id = c.cash_out_id);

  IF n_found NOT IN (0, 20) THEN
    RAISE EXCEPTION 'Expected 20 player-name rows (or 0 on a re-run), found %. '
                    'Stopping: the set changed since this was written.', n_found;
  END IF;

  FOR r IN
    SELECT c.cash_out_id, c.account_id, c.amount, c.occurred_at, c.taken_by
      FROM bank_cash_outs c
     WHERE c.reversed_at IS NULL AND c.amount > 0 AND c.taken_by !~* v_skip
       AND NOT EXISTS (SELECT 1 FROM cash_out_relocations x WHERE x.cash_out_id = c.cash_out_id)
     ORDER BY c.occurred_at, c.cash_out_id
  LOOP
    INSERT INTO leader_transfers (from_leader_user_id, to_leader_user_id, amount,
                                  from_account_id, to_account_id, from_cash, to_cash,
                                  note, created_by_user_id, created_at)
    VALUES (v_ttt, v_ttt, r.amount,
            r.account_id, NULL, false, false,
            'CTC backup to abclub77 - ' || r.taken_by, v_ttt, r.occurred_at)
    RETURNING transfer_id INTO new_id;

    INSERT INTO cash_out_relocations (cash_out_id, original, destination_kind, destination_id, reason, batch)
    SELECT c.cash_out_id, to_jsonb(c), 'leader_transfer', new_id,
           'Paid out to a player at another company''s casino. Client: "direct transfer from your account to player bank account as withdrawals (is consider backup ctc)".', v_batch
      FROM bank_cash_outs c WHERE c.cash_out_id = r.cash_out_id;

    n_transfer := n_transfer + 1;
  END LOOP;

  DELETE FROM bank_cash_outs c
   USING cash_out_relocations x
   WHERE x.cash_out_id = c.cash_out_id AND x.batch = v_batch;
  GET DIAGNOSTICS n_rows = ROW_COUNT;

  RAISE NOTICE 'leader_transfers created: %', n_transfer;
  RAISE NOTICE 'Clear Bank rows removed:  %', n_rows;
  RAISE NOTICE 'Clear Bank rows left:     %', (SELECT count(*) FROM bank_cash_outs WHERE reversed_at IS NULL);
END $$;

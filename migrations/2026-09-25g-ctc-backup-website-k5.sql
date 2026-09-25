-- The last five Clear Bank rows — "Website Cuci", "Website", "K5 tolong cuci" —
-- are CTC backups too, and go where the other twenty went.
--
--     09-11  RHB 2    +502.00   Website Cuci
--     09-11  RHB 2    +380.00   Website Cuci
--     09-23  CIMB 2   +401.00   Website
--     09-24  CIMB 2   +172.00   Website
--     09-16  CIMB 2  -3500.00   K5 tolong cuci
--
-- Arius, on who the far side is: "website cuci is to abclub, k5 is to k5."
--
-- THE SIGNS ARE NOT ALL THE SAME, and the rows have to follow them. A positive
-- cash-out debits, so the four Website rows are money leaving a Pokercity account —
-- written here as a transfer out, `from_account_id` set and the far end not recorded,
-- exactly like 2026-09-25f. The K5 row is stored negative, which in a table of
-- cash-outs means money coming IN, so it is written the other way round: `from_cash`
-- with `to_account_id` set, the same shape as the five "Backup From TTT" rows in
-- 2026-09-25e. Writing all five as outbound would have flipped RM 3,500 the wrong way
-- and put CIMB 2 out by RM 7,000.
--
-- The note says which direction it went, because the columns alone do not read at a
-- glance on the sheet:
--
--     CTC backup to abclub - <label as the sheet wrote it>
--     CTC backup from k5 - <label as the sheet wrote it>
--
-- NO BALANCE MOVES, in either direction. Outbound: a cash-out of +502 contributes
-- -502, and a leader transfer out of 502 contributes -502. Inbound: a cash-out of
-- -3500 contributes +3500, and a leader transfer in of 3500 contributes +3500.
-- `current_balance` is not touched — these rows are being re-filed, not re-banked.
--
-- After this, Clear Bank holds 14 rows and every one of them belongs there: eight
-- genuine ATM cash-outs, the two "Clear bank TTT ind" rows, and the four the bank
-- owner took, which are kept visible on purpose rather than filed away as ordinary
-- transfers.
--
-- Idempotent, guarded on `cash_out_relocations`; reversible, the original row is kept
-- whole as jsonb. The count is asserted at 5.

DO $$
DECLARE
  v_batch constant varchar(60) := '2026-09-25-ctc-backup-website-k5';
  v_ttt   constant int := 56;          -- users.username = 'ttt777'
  v_match constant text := '^website|cuci';
  r          record;
  new_id     int;
  n_found    int;
  n_transfer int := 0;
  n_rows     int := 0;
  v_party    text;
BEGIN

  SELECT count(*) INTO n_found
    FROM bank_cash_outs c
   WHERE c.reversed_at IS NULL AND c.taken_by ~* v_match
     AND NOT EXISTS (SELECT 1 FROM cash_out_relocations x WHERE x.cash_out_id = c.cash_out_id);

  IF n_found NOT IN (0, 5) THEN
    RAISE EXCEPTION 'Expected 5 website/cuci rows (or 0 on a re-run), found %. '
                    'Stopping: the set changed since this was written.', n_found;
  END IF;

  FOR r IN
    SELECT c.cash_out_id, c.account_id, c.amount, c.occurred_at, c.taken_by
      FROM bank_cash_outs c
     WHERE c.reversed_at IS NULL AND c.taken_by ~* v_match
       AND NOT EXISTS (SELECT 1 FROM cash_out_relocations x WHERE x.cash_out_id = c.cash_out_id)
     ORDER BY c.occurred_at, c.cash_out_id
  LOOP
    v_party := CASE WHEN r.taken_by ~* 'k5' THEN 'k5' ELSE 'abclub' END;

    IF r.amount > 0 THEN
      -- Money out of a Pokercity account; the far end is not an account we hold.
      INSERT INTO leader_transfers (from_leader_user_id, to_leader_user_id, amount,
                                    from_account_id, to_account_id, from_cash, to_cash,
                                    note, created_by_user_id, created_at)
      VALUES (v_ttt, v_ttt, r.amount, r.account_id, NULL, false, false,
              'CTC backup to ' || v_party || ' - ' || r.taken_by, v_ttt, r.occurred_at)
      RETURNING transfer_id INTO new_id;
    ELSE
      -- Money in, from outside anything we track.
      INSERT INTO leader_transfers (from_leader_user_id, to_leader_user_id, amount,
                                    from_account_id, to_account_id, from_cash, to_cash,
                                    note, created_by_user_id, created_at)
      VALUES (v_ttt, v_ttt, abs(r.amount), NULL, r.account_id, true, false,
              'CTC backup from ' || v_party || ' - ' || r.taken_by, v_ttt, r.occurred_at)
      RETURNING transfer_id INTO new_id;
    END IF;

    INSERT INTO cash_out_relocations (cash_out_id, original, destination_kind, destination_id, reason, batch)
    SELECT c.cash_out_id, to_jsonb(c), 'leader_transfer', new_id,
           'CTC backup with ' || v_party || '. Arius: "website cuci is to abclub, k5 is to k5."', v_batch
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

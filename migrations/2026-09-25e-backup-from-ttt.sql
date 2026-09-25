-- The five "Backup From TTT" rows → leader transfers in, from cash.
--
-- All five sit on 14 Sept, one per account, and every one of them is stored as a
-- NEGATIVE cash-out:
--
--     BSN 2     -78.00      AMBANK 2  -10.00      CIMB 2  -50.10
--     RHB 2    -140.00      HLBB 2    -19.03                        = -297.13
--
-- `bank_cash_outs` means "somebody took cash out at the bank" and its movement arm
-- is `-amount`, so a negative row is money coming IN. Five inbound payments in a
-- table of withdrawals: the desk had nowhere else to put them, because the money
-- came from outside anything we track. That is also why the UI shows them as "in"
-- with "no source row" — there is no second leg to pair with, and there should not
-- be one.
--
-- Where they belong is the shape the desk already uses for exactly this. On 23 and
-- 24 Sept somebody keyed four rows by hand — "Backup From K5 Rhb1", "Backup From Ac
-- Ambank 1" — as leader transfers with `from_cash` set and no from_account: Tiong AB
-- to Tiong AB, money arriving from outside into one of our accounts. These five are
-- the same event, six weeks earlier, and only landed in Clear Bank because they came
-- in through the import instead of through the form.
--
-- NO BALANCE MOVES. The clear-bank arm contributes `-(-78) = +78`; the leader-transfer
-- to_account arm contributes `+78`. Identical, per account, to the cent. `current_balance`
-- is deliberately not touched — the row is being re-filed, not re-banked.
--
-- WHAT THIS DOES NOT DECIDE. A leader transfer records that the money arrived. It does
-- not record whether the company owes Tiong the 297.13 back. If it does, that is a claim,
-- and claims live in their own table — this migration does not foreclose it either way.
-- The same question is open on the four rows the desk keyed by hand. Both are waiting on
-- the client.
--
-- Idempotent: guarded on `cash_out_relocations`, so a second run is a no-op. Reversible:
-- the original row is preserved whole as jsonb.

DO $$
DECLARE
  v_batch constant varchar(60) := '2026-09-25-backup-from-ttt';
  v_ttt   constant int := 56;          -- users.username = 'ttt777'
  r          record;
  new_id     int;
  n_transfer int := 0;
  n_rows     int := 0;
BEGIN

  FOR r IN
    SELECT c.cash_out_id, c.account_id, c.amount, c.occurred_at, c.taken_by
      FROM bank_cash_outs c
     WHERE c.taken_by ILIKE 'backup from ttt%'
       AND c.amount < 0
       AND c.reversed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM cash_out_relocations x WHERE x.cash_out_id = c.cash_out_id)
     ORDER BY c.occurred_at, c.cash_out_id
  LOOP
    INSERT INTO leader_transfers (from_leader_user_id, to_leader_user_id, amount,
                                  from_account_id, to_account_id, from_cash, to_cash,
                                  note, created_by_user_id, created_at)
    VALUES (v_ttt, v_ttt, abs(r.amount),
            NULL, r.account_id, true, false,
            r.taken_by, v_ttt, r.occurred_at)
    RETURNING transfer_id INTO new_id;

    INSERT INTO cash_out_relocations (cash_out_id, original, destination_kind, destination_id, reason, batch)
    SELECT c.cash_out_id, to_jsonb(c), 'leader_transfer', new_id,
           'Money in from TTT with no source account. Stored as a negative cash-out, which is an inbound row in a table of withdrawals.', v_batch
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

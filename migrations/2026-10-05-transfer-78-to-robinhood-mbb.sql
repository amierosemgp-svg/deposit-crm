-- Transfer 78 landed in Bonus Bear's Maybank; it belongs in Robin Hood's.
--
-- Keyed 5 Oct 22:12 by ivan_bb: CIMB (robinhood) → MBB 2-ENT, RM 8,300.00, reference
-- "clear bank". Both casinos have an account labelled "MBB 2-ENT" and the wrong one was
-- picked: to_account_id 68 is bonusbear's (555171610956), not robinhood's 51
-- (562076551494). Finance flagged it. Every other robinhood "clear bank" top-up —
-- transfers 60, 73, 74, 75 — goes into robinhood's own MBB 2-ENT, and so does every
-- "Clear to MBB 2-ENT" row on Robin Hood's sheet.
--
-- The sender was right, so robinhood CIMB is untouched. What moves is the receiving end:
--
--     bonusbear MBB 2-ENT (68)   -8,300.00   the credit it should never have had
--     robinhood MBB 2-ENT (51)   +8,300.00   the credit it should have had
--
-- `bank_transfers.to_account_id` is what the bank-movements panel reads, so repointing it
-- fixes the flow; `current_balance` is what the desk sees on the card, so it moves by the
-- same amount. The original "credited" ledger row (transactions 66004, entity 45) is
-- left as it was — it is what happened — and two rows record the correction after it.
--
-- Guarded: refuses to run unless transfer 78 still points at account 68 for 8,300.00,
-- so a second run is an error rather than a second move.
--
-- RUN INSIDE A TRANSACTION. Against live, run it once with ROLLBACK and read the
-- notices before running it with COMMIT.

DO $$
DECLARE
  v_transfer constant int := 78;
  v_wrong    constant int := 68;   -- bonusbear MBB 2-ENT
  v_right    constant int := 51;   -- robinhood MBB 2-ENT
  v_by       constant int := 1;    -- dev_demo, as the earlier data fixes
  t          record;
  wrong_acct record;
  right_acct record;
BEGIN
  SELECT * INTO t FROM bank_transfers WHERE transfer_id = v_transfer FOR UPDATE;
  IF t.to_account_id IS DISTINCT FROM v_wrong OR t.amount <> 8300.00 OR t.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Transfer % is not the one finance flagged (to %, RM %, %) — already fixed?',
      v_transfer, t.to_account_id, t.amount, t.status;
  END IF;

  -- Lock both accounts in id order, as the app does.
  PERFORM 1 FROM bank_accounts WHERE account_id IN (v_wrong, v_right) ORDER BY account_id FOR UPDATE;
  SELECT * INTO wrong_acct FROM bank_accounts WHERE account_id = v_wrong;
  SELECT * INTO right_acct FROM bank_accounts WHERE account_id = v_right;

  IF wrong_acct.current_balance < t.amount THEN
    RAISE EXCEPTION 'Bonus Bear MBB 2-ENT holds %, which does not cover %',
      wrong_acct.current_balance, t.amount;
  END IF;

  RAISE NOTICE 'before: bonusbear MBB 2-ENT %, robinhood MBB 2-ENT %',
    wrong_acct.current_balance, right_acct.current_balance;

  UPDATE bank_transfers
     SET to_account_id = v_right,
         notes = coalesce(notes || ' ', '') ||
                 '[5 Oct: receiving account corrected from bonusbear MBB 2-ENT to robinhood MBB 2-ENT, per finance.]'
   WHERE transfer_id = v_transfer;

  UPDATE bank_accounts SET current_balance = current_balance - t.amount WHERE account_id = v_wrong;
  UPDATE bank_accounts SET current_balance = current_balance + t.amount WHERE account_id = v_right;

  INSERT INTO transactions (entity_id, type, amount, reference_id, user_id, details)
  VALUES
    (wrong_acct.entity_id, 'bank_transfer', t.amount, v_transfer, v_by,
     jsonb_build_object(
       'action', 'credit_corrected_out',
       'from_account', (SELECT account_number FROM bank_accounts WHERE account_id = t.from_account_id),
       'to_account', wrong_acct.account_number,
       'moved_to_account', right_acct.account_number,
       'balance_after', wrong_acct.current_balance - t.amount,
       'reason', 'Wrong receiving account: credited bonusbear MBB 2-ENT instead of robinhood MBB 2-ENT.',
       'by', 'data correction')),
    (right_acct.entity_id, 'bank_transfer', t.amount, v_transfer, v_by,
     jsonb_build_object(
       'action', 'credited',
       'from_account', (SELECT account_number FROM bank_accounts WHERE account_id = t.from_account_id),
       'to_account', right_acct.account_number,
       'moved_from_account', wrong_acct.account_number,
       'balance_after', right_acct.current_balance + t.amount,
       'settled', 'correction of transfer 78 — receiving account was wrong',
       'by', 'data correction'));

  RAISE NOTICE 'after:  bonusbear MBB 2-ENT %, robinhood MBB 2-ENT %',
    (SELECT current_balance FROM bank_accounts WHERE account_id = v_wrong),
    (SELECT current_balance FROM bank_accounts WHERE account_id = v_right);
END $$;

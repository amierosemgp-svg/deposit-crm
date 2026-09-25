-- Move the wrongly-imported rows out of Clear Bank and into the tables they belong to.
--
-- Read `2026-09-24b-cash-out-relocations.sql` first: the Clear Bank tab is ours, not
-- the client's, and this import created it. Of the 87 imported rows, most are not
-- cash anybody took out at a bank.
--
-- HOW THE INTERNAL TRANSFERS WERE FOUND. The import wrote both ends of every move
-- between our own accounts: a positive row on the account that sent ("BACKUP TO RHB 2")
-- and a negative row of the same amount, same day, on the account that received
-- ("BACKUP FROM CIMB"). That is why 45 backup rows net to only RM 1,277 — they are
-- twenty-odd transfers counted twice, once each way.
--
-- So the pairing is done on (date, amount), never on the text. The text is what
-- somebody typed at the time and it is wrong often enough to be useless as a key:
-- row 302 says "BACKUP TO RHB" and its other leg landed in AMBANK; rows 345 and 346
-- say "Backup From Kalai" when both legs are our own CIMB 3 and MBB 2. The two
-- account ids are unambiguous, so the accounts decide and the text is kept verbatim
-- in `reference` for whoever reads it later.
--
-- WHAT THIS FILE DOES NOT TOUCH, and why:
--   * cash_out 329/339 (RM 30) and 330/331 (RM 760) — these pair like any other
--     internal move, but Arius says the bank owner took this money. Recording them as
--     ordinary transfers would bury that. Left in Clear Bank, deliberately.
--   * the five negative "Backup From TTT" rows (RM 297.13 total, all 14 Sep) — no
--     matching leg, purpose unknown.
--   * cash_out 281 and 292, "Clear bank TTT ind" (RM 3,990.65 + RM 2,980.00) — genuine
--     clear-bank rows. See section 4.
--   * the twenty player-name rows — the client's Appendix A calls them withdrawals,
--     but their own workbook shows the same names and the same amounts (MOHD ASRAFF
--     0.50 + 0.50, MARIATI 0.08) as *deposits* marked FORFEIT. Unresolved; moving them
--     on a guess would be worse than leaving them.
--   * "Website Cuci", "K5 tolong cuci", and the genuine `kc` / KC ATM rows. The last
--     of these are what Clear Bank is actually for and they stay.
--
-- THE ONE-TO-MANY. Row 297, "BACKUP TO RHB & RHB2", RM 4,458 out of CIMB, has two
-- receiving legs: 298 (RHB, 2,046) and 299 (RHB 2, 2,412). Arius said to split a
-- two-bank row half and half, which would be 2,229 each — but that instruction was
-- given before we knew the receiving legs existed, and they record the real split.
-- The recorded split is used. 2,046 + 2,412 = 4,458 exactly.
--
-- Idempotent: every row is guarded on `cash_out_relocations`, so running this twice
-- is a no-op. Reversible: the original row is preserved whole as jsonb.
--
-- RUN INSIDE A TRANSACTION. Against live, run it once with ROLLBACK and read the
-- notices before running it with COMMIT.

DO $$
DECLARE
  v_batch   constant varchar(60) := '2026-09-24-clearbank-import';
  MARK    constant text := 'Clear Bank — imported row PC-C-%';
  -- Left in Clear Bank on purpose: the bank owner took this money.
  THEFT   constant int[] := ARRAY[329, 330, 331, 339];
  r           record;
  new_id      int;
  n_transfer  int := 0;
  n_rows      int := 0;
BEGIN

  ---------------------------------------------------------------------------
  -- 1. Matched pairs → one bank_transfer each, both legs relocated.
  ---------------------------------------------------------------------------
  FOR r IN
    WITH imported AS (
      SELECT cash_out_id, account_id, occurred_at, amount, taken_by, recorded_by_user_id
        FROM bank_cash_outs
       WHERE reversed_at IS NULL
         AND notes LIKE MARK
         AND NOT (cash_out_id = ANY (THEFT))
    )
    SELECT p.cash_out_id AS out_id, p.account_id AS from_acct, p.occurred_at, p.amount,
           p.taken_by AS out_label, p.recorded_by_user_id AS by_user,
           n.cash_out_id AS in_id,  n.account_id AS to_acct, n.taken_by AS in_label
      FROM imported p
      JOIN imported n
        ON n.occurred_at::date = p.occurred_at::date
       AND n.amount = -p.amount
     WHERE p.amount > 0
       AND NOT EXISTS (SELECT 1 FROM cash_out_relocations x WHERE x.cash_out_id = p.cash_out_id)
     ORDER BY p.occurred_at, p.cash_out_id
  LOOP
    INSERT INTO bank_transfers (from_account_id, to_account_id, amount, reference, notes,
                                status, skip_bot, initiated_by_user_id, confirmed_by_user_id,
                                confirmed_at, created_at)
    VALUES (r.from_acct, r.to_acct, r.amount, left(r.out_label, 80),
            format('Relocated out of Clear Bank (rows %s and %s, batch %s). Original labels: %L / %L.',
                   r.out_id, r.in_id, v_batch, r.out_label, r.in_label),
            'confirmed', true, r.by_user, r.by_user, r.occurred_at, r.occurred_at)
    RETURNING transfer_id INTO new_id;

    INSERT INTO cash_out_relocations (cash_out_id, original, destination_kind, destination_id, reason, batch)
    SELECT c.cash_out_id, to_jsonb(c), 'bank_transfer', new_id,
           'Sending leg of an internal transfer the import wrote as a Clear Bank cash-out.', v_batch
      FROM bank_cash_outs c WHERE c.cash_out_id = r.out_id;

    INSERT INTO cash_out_relocations (cash_out_id, original, destination_kind, destination_id, reason, batch)
    SELECT c.cash_out_id, to_jsonb(c), 'bank_transfer', new_id,
           'Receiving leg of the same transfer; the import double-counted it.', v_batch
      FROM bank_cash_outs c WHERE c.cash_out_id = r.in_id;

    n_transfer := n_transfer + 1;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2. Row 297 → its two recorded receiving legs.
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT p.cash_out_id AS out_id, p.account_id AS from_acct, p.occurred_at,
           p.taken_by AS out_label, p.recorded_by_user_id AS by_user,
           n.cash_out_id AS in_id, n.account_id AS to_acct, -n.amount AS amount, n.taken_by AS in_label
      FROM bank_cash_outs p
      JOIN bank_cash_outs n
        ON n.occurred_at::date = p.occurred_at::date AND n.amount < 0 AND n.reversed_at IS NULL
     WHERE p.cash_out_id = 297 AND n.cash_out_id IN (298, 299)
       AND p.reversed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM cash_out_relocations x WHERE x.cash_out_id = n.cash_out_id)
     ORDER BY n.cash_out_id
  LOOP
    INSERT INTO bank_transfers (from_account_id, to_account_id, amount, reference, notes,
                                status, skip_bot, initiated_by_user_id, confirmed_by_user_id,
                                confirmed_at, created_at)
    VALUES (r.from_acct, r.to_acct, r.amount, left(r.out_label, 80),
            format('Relocated out of Clear Bank. Row %s sent RM 4,458.00 to two accounts; this is the %s leg (row %s). Batch %s.',
                   r.out_id, r.in_label, r.in_id, v_batch),
            'confirmed', true, r.by_user, r.by_user, r.occurred_at, r.occurred_at)
    RETURNING transfer_id INTO new_id;

    INSERT INTO cash_out_relocations (cash_out_id, original, destination_kind, destination_id, reason, batch)
    SELECT c.cash_out_id, to_jsonb(c), 'bank_transfer', new_id,
           'One of two receiving legs of row 297, which sent to RHB and RHB 2 in one line.', v_batch
      FROM bank_cash_outs c WHERE c.cash_out_id = r.in_id;

    n_transfer := n_transfer + 1;
  END LOOP;

  -- The sending row itself is relocated once, after both its legs.
  INSERT INTO cash_out_relocations (cash_out_id, original, destination_kind, destination_id, reason, batch)
  SELECT c.cash_out_id, to_jsonb(c), 'bank_transfer', NULL,
         'Sending row of a two-bank transfer; split across the two receiving legs above.', v_batch
    FROM bank_cash_outs c
   WHERE c.cash_out_id = 297
     AND EXISTS (SELECT 1 FROM cash_out_relocations x WHERE x.cash_out_id IN (298, 299))
     AND NOT EXISTS (SELECT 1 FROM cash_out_relocations x WHERE x.cash_out_id = 297);

  ---------------------------------------------------------------------------
  -- 3. The two company-to-company payments to Amazon Club.
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT c.cash_out_id, c.account_id AS from_acct, c.amount, c.occurred_at,
           c.taken_by, c.recorded_by_user_id AS by_user,
           (SELECT account_id FROM bank_accounts
             WHERE entity_id = 11 AND label = CASE WHEN c.taken_by ILIKE '%AC2%'
                                                   THEN 'AC2 (RHB)' ELSE 'AC (Affin)' END) AS to_acct
      FROM bank_cash_outs c
     WHERE c.cash_out_id IN (290, 300) AND c.reversed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM cash_out_relocations x WHERE x.cash_out_id = c.cash_out_id)
  LOOP
    IF r.to_acct IS NULL THEN
      RAISE EXCEPTION 'Amazon Club accounts are missing — run 2026-09-24c first.';
    END IF;

    INSERT INTO bank_transfers (from_account_id, to_account_id, amount, reference, notes,
                                status, skip_bot, initiated_by_user_id, confirmed_by_user_id,
                                confirmed_at, created_at)
    VALUES (r.from_acct, r.to_acct, r.amount, left(r.taken_by, 80),
            format('Company-to-company payment to Amazon Club, relocated out of Clear Bank (row %s, batch %s).',
                   r.cash_out_id, v_batch),
            'confirmed', true, r.by_user, r.by_user, r.occurred_at, r.occurred_at)
    RETURNING transfer_id INTO new_id;

    INSERT INTO cash_out_relocations (cash_out_id, original, destination_kind, destination_id, reason, batch)
    SELECT c.cash_out_id, to_jsonb(c), 'bank_transfer', new_id,
           'Payment out to Amazon Club — the only backup rows with no second leg, because the far account is not ours.', v_batch
      FROM bank_cash_outs c WHERE c.cash_out_id = r.cash_out_id;

    n_transfer := n_transfer + 1;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4. The two "Clear bank TTT ind" rows (281, 292) are LEFT ALONE.
  --
  -- They were briefly going to become a claim, on the strength of one line in the
  -- client's reply to our inquiry: "Ttt is new bank balance that paid by you yet to
  -- claim back from company. You key in as a claim record." That line names no row,
  -- and the inquiry we sent did not list these two — so matching it to 281/292 was
  -- our inference, not their answer. Three things say the inference was wrong:
  --
  --   * the label is literally "Clear bank TTT ind" — the same form as "Kc Atm Clear
  --     Bank", which is what this table is for;
  --   * the sign is a debit, and the payee (TTT's personal account) is where the
  --     money went. Money out, not money in;
  --   * with both rows kept, `opening + in - out = current_balance` holds to the cent
  --     on all ten Pokercity accounts. Relocate them and BSN 2 is out by 3,990.65 and
  --     RHB 2 by 2,980.00 — and RHB 2 would need a negative opening balance to close.
  --
  -- If there is a real claim, they have to point at the rows. Until then nothing here
  -- creates one, and `claims` is created empty by 2026-09-24-claims.sql.
  ---------------------------------------------------------------------------

  ---------------------------------------------------------------------------
  -- 5. Remove every relocated row from Clear Bank.
  ---------------------------------------------------------------------------
  DELETE FROM bank_cash_outs c
   USING cash_out_relocations x
   WHERE x.cash_out_id = c.cash_out_id AND x.batch = v_batch;
  GET DIAGNOSTICS n_rows = ROW_COUNT;

  RAISE NOTICE 'bank_transfers created: %', n_transfer;
  RAISE NOTICE 'Clear Bank rows removed: %', n_rows;
  RAISE NOTICE 'Clear Bank rows left:    %', (SELECT count(*) FROM bank_cash_outs WHERE reversed_at IS NULL);
END $$;

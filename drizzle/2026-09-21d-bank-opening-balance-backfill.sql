-- Fill in the opening balances, derived from what the movements cannot explain.
--
-- For each account: current_balance minus the sum of every recorded movement
-- ever. Whatever is left over was there before the history starts, which is the
-- opening balance by definition. The four accounts opened after launch come out
-- at exactly 0.00, which is the check that the six movement types below are the
-- complete set — if one were missing, those four would not reconcile either.
--
-- Derived, not sourced: nobody wrote these figures down on 18 Sept, so they are
-- recovered from the arithmetic rather than from the operator's workbook. That
-- makes them self-consistent by construction. If Pokercity later produces the
-- real 31 Aug closing balances and they differ, the difference is a genuine
-- finding about the migration, and these values should be corrected to theirs.
--
-- Dated 2026-08-31 Malaysia time: the earliest recorded movement is 1 Sept MYT,
-- so the opening sits before all of it and no period double-counts it.
--
-- current_balance is not touched. This writes only the two new columns, so no
-- money moves and a re-run changes nothing (it skips accounts already set).
BEGIN;

WITH movements AS (
  SELECT received_into_account_id AS account_id, sum(deposit_amount) AS delta
    FROM deposits WHERE status = 'completed' GROUP BY 1
  UNION ALL
  SELECT paid_from_account_id,
         -sum(coalesce(nullif(credit_pulled_amount, 0), requested_amount))
    FROM withdrawals WHERE status = 'paid' GROUP BY 1
  UNION ALL
  SELECT paid_from_account_id, -sum(amount) FROM expenses GROUP BY 1
  UNION ALL
  SELECT account_id, -sum(amount)
    FROM bank_cash_outs WHERE reversed_at IS NULL GROUP BY 1
  UNION ALL
  SELECT from_account_id, -sum(amount) FROM leader_transfers GROUP BY 1
  UNION ALL
  SELECT to_account_id,    sum(amount) FROM leader_transfers GROUP BY 1
  UNION ALL
  SELECT from_account_id, -sum(amount)
    FROM bank_transfers WHERE status = 'confirmed' GROUP BY 1
  UNION ALL
  SELECT to_account_id,    sum(amount)
    FROM bank_transfers WHERE status = 'confirmed' GROUP BY 1
),
residual AS (
  SELECT b.account_id,
         round(b.current_balance - coalesce(sum(m.delta), 0), 2) AS opening
    FROM bank_accounts b
    LEFT JOIN movements m ON m.account_id = b.account_id
   GROUP BY b.account_id, b.current_balance
)
UPDATE bank_accounts b
   SET opening_balance    = r.opening,
       opening_balance_at = TIMESTAMPTZ '2026-08-31 00:00:00+08'
  FROM residual r
 WHERE r.account_id = b.account_id
   AND r.opening <> 0
   -- Idempotent: an account whose opening is already recorded is left alone.
   AND b.opening_balance = 0;

COMMIT;

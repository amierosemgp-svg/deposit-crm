-- Proof that relocating the imported Clear Bank rows did not move any money.
--
--     psql -d <db> -f scripts/verify-clearbank-relocation.sql
--
-- Run it against a copy of production restored *before* the migration, note the
-- numbers, run the migration, run it again. **Every account must be identical to the
-- cent.** Nothing here moves money: each relocated pair leaves the sending account by
-- the same amount it enters the receiving one, exactly as the two cash-out rows did.
-- An account that moves means a row was paired wrongly.
--
-- Why this check and not a balance column: `bank_accounts.current_balance` is what
-- the bot writes, not what the ledger says. The number that matters is the sum of
-- every movement the desk actually renders, which is the query in
-- `src/app/api/bank-movements/route.ts`. The first block below is that query's
-- clear-bank and bank-transfer arms, which are the only two this migration touches.

\echo ''
\echo '=== 1. Net movement per account (clear bank + bank transfers) ==='
WITH m AS (
  SELECT account_id, -amount AS delta FROM bank_cash_outs WHERE reversed_at IS NULL
  UNION ALL SELECT from_account_id, -amount FROM bank_transfers WHERE status = 'confirmed'
  UNION ALL SELECT to_account_id,    amount FROM bank_transfers WHERE status = 'confirmed'
)
SELECT ba.label, round(sum(m.delta), 2) AS net
  FROM m JOIN bank_accounts ba USING (account_id)
 GROUP BY ba.label ORDER BY ba.label;

\echo ''
\echo '=== 2. What is left in Clear Bank, and why ==='
SELECT CASE
    WHEN taken_by ILIKE 'clear bank ttt%' THEN 'KEPT — clear bank, out to TTT individual'
    WHEN taken_by ILIKE 'kc%'             THEN 'KEPT — cash out at the ATM'
    WHEN taken_by ILIKE '%kalai%' OR taken_by = '/' OR taken_by ILIKE 'clear bank to mbb%'
                                          THEN 'LEFT — bank owner took this money'
    ELSE 'UNEXPECTED — should be none, investigate'
  END AS bucket,
  count(*) AS rows, round(sum(amount), 2) AS total
  FROM bank_cash_outs WHERE reversed_at IS NULL
 GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== 3. What was relocated ==='
SELECT destination_kind, count(*) AS rows, round(sum((original->>'amount')::numeric), 2) AS total
  FROM cash_out_relocations GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== 4. Claims — expected to be EMPTY until the client names the rows ==='
SELECT c.claim_id, u.username, ba.label AS paid_into, c.amount, c.occurred_at::date, c.status
  FROM claims c JOIN users u ON u.user_id = c.claimed_by_user_id
  LEFT JOIN bank_accounts ba ON ba.account_id = c.paid_into_account_id
 ORDER BY c.occurred_at;

\echo ''
\echo '=== 5. Nothing should be relocated twice, and nothing relocated should remain ==='
SELECT (SELECT count(*) FROM (SELECT cash_out_id FROM cash_out_relocations
                               GROUP BY 1 HAVING count(*) > 1) d)         AS duplicate_relocations,
       (SELECT count(*) FROM bank_cash_outs c JOIN cash_out_relocations x
          USING (cash_out_id))                                            AS still_in_clear_bank;

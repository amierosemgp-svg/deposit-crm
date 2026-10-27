-- Indexes for one casino at a time, and for the bank cards.
--
-- 2026-10-27-sheet-indexes.sql made the whole house fast. Picking one casino
-- in the top bar was still slow on staging (840k deposits): its Deposit sheet
-- walked the date index across every casino looking for its own rows (18s),
-- its totals read the whole table (5s), and the bank cards summed every
-- account's deposits and withdrawals before keeping the ones on screen
-- (5s + 6s).
--
-- CONCURRENTLY, so run with `psql -f`, outside a transaction; set
-- statement_timeout = 0 first on a big table. Safe to re-run; drop any
-- INVALID index a failed build leaves and run again.

-- One casino's Deposit sheet and its totals.
CREATE INDEX CONCURRENTLY IF NOT EXISTS deposits_company_date_idx
  ON deposits (company_entity_id, deposit_date DESC, deposit_id DESC);

-- Bank cards: completed deposits per receiving account, summed off the index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS deposits_received_completed_idx
  ON deposits (received_into_account_id, deposit_date)
  INCLUDE (deposit_amount, bonus_amount)
  WHERE status = 'completed';

-- Bank cards: paid withdrawals per paying account.
CREATE INDEX CONCURRENTLY IF NOT EXISTS withdrawals_paid_from_idx
  ON withdrawals (paid_from_account_id, created_at)
  INCLUDE (credit_pulled_amount, requested_amount)
  WHERE status = 'paid';

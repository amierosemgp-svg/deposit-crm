-- Indexes for the sheets' first load and the 10-second poll.
--
-- After the September import (staging: 840k deposits, 129k withdrawals, 2.05M
-- ledger rows) the Transactions page took ~25s to open. Every query behind it
-- read its whole table: the sheets filter and sort deposits on deposit_date,
-- /api/state takes the newest 500 by created_at, and the Free Credit list
-- reads ledger rows by details->>'action' — none of which had an index.
--
-- CONCURRENTLY, so a live database keeps taking deposits while they build.
-- That needs autocommit: run with `psql -f`, not inside a transaction. Safe to
-- re-run; a build that failed half way leaves an INVALID index — drop it and
-- run again.

-- The Deposit sheet: a business-day range, newest first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS deposits_deposit_date_idx
  ON deposits (deposit_date DESC, deposit_id DESC);

-- /api/state: the newest 500 deposits.
CREATE INDEX CONCURRENTLY IF NOT EXISTS deposits_created_at_idx
  ON deposits (created_at DESC);

-- The Withdrawal sheet and /api/state's newest 500.
CREATE INDEX CONCURRENTLY IF NOT EXISTS withdrawals_created_at_idx
  ON withdrawals (created_at DESC, withdrawal_id DESC);

-- Free credits and staff-error bonuses: game_topup rows told apart by
-- details.action, read newest first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS transactions_topup_action_idx
  ON transactions ((details->>'action'), created_at DESC)
  WHERE type = 'game_topup';

-- A deposit's completion and reversal rows, looked up by the deposit id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS transactions_reference_idx
  ON transactions (reference_id)
  WHERE reference_id IS NOT NULL;

-- The Game Transfer sheet and /api/state, newest first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS game_transfers_created_at_idx
  ON game_transfers (created_at DESC);

-- From 2026-07-30-game-transfer-note-timing.sql; missing from the staging
-- restore.
CREATE INDEX CONCURRENTLY IF NOT EXISTS game_transfers_status_idx
  ON game_transfers (status);

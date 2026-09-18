-- The worksheet now says, per row, whether the work was done by hand or by the
-- agent. Deposits and withdrawals already carry skip_bot; game transfers did
-- not, so their Mode column had nothing to read.
--
-- Deliberately nullable with no backfill. A manual transfer and an agent one
-- are not reliably distinguishable in the rows already recorded — RajaClub's
-- imported ID-TO-ID moves were done by hand, the agent's were not, and both
-- look the same in the columns we kept. Guessing would print a confident
-- "Manual" over rows nobody can vouch for, so history reads blank and every
-- row written from here on says which it was.

ALTER TABLE game_transfers ADD COLUMN IF NOT EXISTS skip_bot boolean;

COMMENT ON COLUMN game_transfers.skip_bot IS
  'true = CS moved the credit in the back-office; false = the agent did. NULL on rows written before the column existed.';

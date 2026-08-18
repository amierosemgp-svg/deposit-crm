-- "Withdraw all": take whatever is actually in the wallet.
--
-- The CRM's game_credits is a cache the agent refreshes, so it lags the real
-- provider wallet — a player showing RM 17 here may hold RM 100 there. Two
-- consequences, both fixed by this column:
--
--   1. A request could never be raised for more than the cached figure, which
--      meant CS could not act on what the player could actually see.
--   2. "Withdraw all" had to be turned into a number at request time, so it
--      pulled the stale figure rather than the wallet.
--
-- With the flag stored, the amount becomes optional and the agent is told to
-- empty the wallet and report back what was really there.

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS withdraw_all boolean NOT NULL DEFAULT false;

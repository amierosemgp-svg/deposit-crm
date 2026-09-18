-- Where a leader settlement actually came from, and where it went.
--
-- The row recorded that RM 9,000 moved from one leader to another and nothing
-- about how. Reconciling it afterwards meant asking someone: was that out of
-- the Maybank account, or did it change hands as cash? Both happen, and only
-- one of them should ever show up against a bank balance.
--
-- Each end is one of three states, and they are deliberately distinguishable:
--   account_id set   → that CRM bank account
--   cash = true      → physical cash, no account involved
--   neither          → not recorded (every row written before this migration)
--
-- A nullable account alone could not say that — every historical row would
-- have read as "cash", which is a claim nobody made.
--
-- Additive: four nullable/defaulted columns. Nothing existing changes, and no
-- balance moves off the back of this — see the note in the POST handler.

ALTER TABLE leader_transfers
  ADD COLUMN IF NOT EXISTS from_account_id integer REFERENCES bank_accounts(account_id),
  ADD COLUMN IF NOT EXISTS to_account_id   integer REFERENCES bank_accounts(account_id),
  ADD COLUMN IF NOT EXISTS from_cash       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS to_cash         boolean NOT NULL DEFAULT false;

-- An end is an account or it is cash, never both.
ALTER TABLE leader_transfers
  DROP CONSTRAINT IF EXISTS leader_transfers_from_end_ck;
ALTER TABLE leader_transfers
  ADD CONSTRAINT leader_transfers_from_end_ck
  CHECK (NOT (from_cash AND from_account_id IS NOT NULL));

ALTER TABLE leader_transfers
  DROP CONSTRAINT IF EXISTS leader_transfers_to_end_ck;
ALTER TABLE leader_transfers
  ADD CONSTRAINT leader_transfers_to_end_ck
  CHECK (NOT (to_cash AND to_account_id IS NOT NULL));

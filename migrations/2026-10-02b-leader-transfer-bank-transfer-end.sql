-- A leader settlement's end can be "Bank Transfer" — paid by bank, but not
-- from or into one of our accounts.
--
-- Until now an end was one of our accounts (and moved its balance), Cash, or
-- not recorded. Leaders settle bank-to-bank from their own accounts all the
-- time; that is neither cash nor ours to book. Like Cash, this end moves no
-- balance — it only says how the money went.
--
-- Additive and defaulted: code deployed before this column exists never reads
-- it, and every existing row is correctly "not a bank transfer".
ALTER TABLE leader_transfers
  ADD COLUMN IF NOT EXISTS from_bank_transfer boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS to_bank_transfer boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN leader_transfers.from_bank_transfer IS
  'Sending end paid by bank transfer from an account the CRM does not keep; moves no balance.';
COMMENT ON COLUMN leader_transfers.to_bank_transfer IS
  'Receiving end paid by bank transfer into an account the CRM does not keep; moves no balance.';

-- What each bank account held before the CRM recorded anything.
--
-- The eleven accounts were created on migration day (2026-09-18) and their
-- balances were set by a direct UPDATE, with no row behind the money. So the
-- balance on screen could never be explained by the movements on screen: seven
-- of the eleven carry RM 24,506.05 between them that simply appeared.
--
-- That is the whole reason the bank cards cannot be proved. Deposits, withdraw-
-- als, expenses, Clear Bank, leader transfers and bank transfers are the six
-- things that move a balance, and for the four accounts opened after launch
-- they already reconcile to the cent. Recording the opening balance closes the
-- other seven, and the card becomes an equation anyone can check:
--
--     opening + in - out = balance now
--
-- Additive and defaulted, so the currently deployed code neither sees nor
-- needs these columns.
ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  -- When that opening was struck. Null means "no opening recorded", which for
  -- an account opened after launch is the truth, not a gap.
  ADD COLUMN IF NOT EXISTS opening_balance_at timestamptz;

COMMENT ON COLUMN bank_accounts.opening_balance IS
  'Balance held before the first recorded movement; part of opening + in - out = current_balance.';
COMMENT ON COLUMN bank_accounts.opening_balance_at IS
  'When the opening balance was struck. Null = account opened inside the recorded history.';

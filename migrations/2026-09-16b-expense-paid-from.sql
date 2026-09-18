-- What an expense was actually paid out of.
--
-- The row said RM 40 went on phone top-ups and nothing about where the money
-- came from, so reconciling a bank statement against it meant asking someone.
-- Two answers are possible and they reconcile against different things: one of
-- our bank accounts, or a leader's own cash.
--
-- Cash names the leader on purpose. An expense has a company but no leader
-- column, so a bare boolean would record that cash was used without recording
-- whose — which is the one thing that makes it settleable later.
--
-- Three states per expense, deliberately distinguishable:
--   paid_from_account_id     set → that CRM bank account
--   paid_from_cash_entity_id set → that leader's cash
--   neither                      → not recorded (every pre-existing row)
--
-- Additive: two nullable columns. Nothing existing changes, and no balance
-- moves off the back of this — an expense that should also show against a bank
-- account is entered as a bank cash-out, exactly as before.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS paid_from_account_id integer REFERENCES bank_accounts(account_id),
  ADD COLUMN IF NOT EXISTS paid_from_cash_entity_id integer REFERENCES entities(entity_id);

-- An expense is paid from an account or from someone's cash, never both.
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_paid_from_ck;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_paid_from_ck
  CHECK (paid_from_account_id IS NULL OR paid_from_cash_entity_id IS NULL);

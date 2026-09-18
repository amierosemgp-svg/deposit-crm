-- Bank charges, and expenses that actually move the bank balance.
--
-- An expense already recorded which account paid it, and then left that
-- account's balance untouched — so RM 100 of bank charges left the bank and
-- the CRM went on believing the money was there. Every figure built on that
-- balance (the sheet's Bank card, the daily report's bank line) was over by
-- the total of every expense ever paid out of an account.
--
-- Two enum values for it:
--   expense_category.bank_charge — the thing being recorded, named as the desk
--     names it. It was going in as "other", which is where a recurring monthly
--     cost goes to be invisible.
--   audit_type.expense — expenses can now write a ledger row like every other
--     movement of a bank balance, so the account's history explains itself.
--
-- Additive: two enum values, nothing rewritten. Expenses recorded before this
-- never debited anything, and are not retro-applied — the balances were
-- reconciled against the bank as they stood.

ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'bank_charge';
ALTER TYPE audit_type ADD VALUE IF NOT EXISTS 'expense';

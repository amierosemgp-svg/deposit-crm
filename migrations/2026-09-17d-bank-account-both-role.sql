-- One account that both collects deposits and pays withdrawals.
--
-- The role was a choice of two, which forced a house running a single account
-- to register it twice — two rows, two balances for one real account, and a
-- reconciliation that could never close. "both" says what is actually true.
--
-- Additive: one enum value. Every existing account keeps the role it has, and
-- code that asks "is this a deposit account?" now asks whether the role is
-- deposit *or* both (see takesDeposits / paysWithdrawals in lib/types.ts).

ALTER TYPE bank_account_role ADD VALUE IF NOT EXISTS 'both';

-- Bank cash-outs: a leader taking cash out of a company bank account.
--
-- Money leaves a company account in three ways the CRM already knows — a
-- player withdrawal, a transfer to another company account — and one it
-- didn't: the leader walks to the bank and withdraws cash. Until now CS had
-- nowhere to record that, so the account's balance in the CRM drifted above
-- the real one. This adds the record: which account, how much, who took it,
-- when, and who entered it. Recording it debits the account; reversing it
-- (leaders/admins) puts the amount back and keeps the row as history.
--
-- Additive: one table and one audit type. Nothing existing changes.

-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block on
-- older Postgres; run this file statement by statement if the editor wraps it.
ALTER TYPE audit_type ADD VALUE IF NOT EXISTS 'bank_cash_out';

CREATE TABLE IF NOT EXISTS bank_cash_outs (
  cash_out_id           serial PRIMARY KEY,
  account_id            integer NOT NULL REFERENCES bank_accounts(account_id),
  -- The company the account belongs to, denormalised for scoping.
  entity_id             integer NOT NULL REFERENCES entities(entity_id),
  amount                numeric(14,2) NOT NULL,
  -- Who took the cash: the leader entity when it's one of ours, and always a
  -- name — the leader's, or whoever else CS typed.
  taken_by_entity_id    integer REFERENCES entities(entity_id),
  taken_by              varchar(120) NOT NULL,
  -- When the cash actually left the bank (the receipt's time, not ours).
  occurred_at           timestamptz NOT NULL,
  notes                 text,
  recorded_by_user_id   integer REFERENCES users(user_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Set when a leader/admin reverses it; the amount is back on the account.
  reversed_at           timestamptz,
  reversed_by_user_id   integer REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS bank_cash_outs_account_idx
  ON bank_cash_outs (account_id, occurred_at DESC);

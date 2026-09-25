-- Money a person paid out of their own pocket that the company owes back.
--
-- Nothing in the schema could hold this. `expenses` is money the company spent
-- and will not see again; `leader_transfers` and `bank_transfers` move money
-- between accounts the company already owns; `deposits` and `withdrawals` are a
-- player's money. A claim is none of those: the company's bank balance went up,
-- but it went up on someone else's money, and that someone is owed.
--
-- Why it exists: the client asked for it. Answering our inquiry about the Clear Bank
-- rows they wrote, unprompted: "Ttt is new bank balance that paid by you yet to claim
-- back from company. You key in as a claim record." There was nowhere to key it in.
--
-- The table is created EMPTY. An earlier draft of 2026-09-24d filled it with two rows
-- (cash_out 281 and 292, RM 6,970.65) on the assumption that those were the payments
-- that line referred to. They are not — the label reads "Clear bank TTT ind", the sign
-- is a debit, and leaving them alone is what makes every account reconcile. They stay
-- in Clear Bank. Which rows the client actually meant is still an open question for
-- them, and the answer goes in here when it arrives.
--
-- `claimed_by_user_id` is who is owed. `entity_id` is who owes them — the company
-- the money went into, not the claimant's own entity, because a leader can fund an
-- account belonging to any company under them. `paid_into_account_id` is nullable:
-- not every claim lands in a bank account we track (cash handed to an agent, a fee
-- paid direct), and a claim with no account is still a debt.
--
-- Additive: one enum, one table, nothing existing is touched.

CREATE TYPE claim_status AS ENUM ('outstanding', 'settled', 'cancelled');

CREATE TABLE claims (
  claim_id             serial PRIMARY KEY,
  entity_id            integer NOT NULL REFERENCES entities(entity_id),
  claimed_by_user_id   integer NOT NULL REFERENCES users(user_id),
  paid_into_account_id integer REFERENCES bank_accounts(account_id),
  amount               numeric(14,2) NOT NULL,
  occurred_at          timestamptz NOT NULL,
  reason               varchar(200) NOT NULL,
  notes                text,
  status               claim_status NOT NULL DEFAULT 'outstanding',
  settled_at           timestamptz,
  settled_by_user_id   integer REFERENCES users(user_id),
  -- Paying the claim back is real money leaving a real account, so settling
  -- names the account it came out of and debits it in the same step. Nullable
  -- because a claim can also be settled in cash, or written off.
  settled_from_account_id integer REFERENCES bank_accounts(account_id),
  recorded_by_user_id  integer REFERENCES users(user_id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- The list is read per company, newest first, and filtered by status far more
-- often than by anything else.
CREATE INDEX claims_entity_occurred_idx ON claims (entity_id, occurred_at DESC);
CREATE INDEX claims_status_idx ON claims (status);

-- A settled claim must say when and by whom; an outstanding one must not pretend to.
ALTER TABLE claims ADD CONSTRAINT claims_settled_fields_ck
  CHECK ((status = 'settled') = (settled_at IS NOT NULL));

ALTER TABLE claims ADD CONSTRAINT claims_amount_positive_ck CHECK (amount > 0);

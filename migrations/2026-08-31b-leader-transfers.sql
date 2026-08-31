-- Transfers between leaders — settlements moving funds from one leader to
-- another. Kept separate from expenses (operational costs) and bank_transfers
-- (account-to-account), so leader-to-leader flow reports on its own.

-- New audit type for the unified transaction history / filter.
ALTER TYPE audit_type ADD VALUE IF NOT EXISTS 'leader_transfer';

CREATE TABLE IF NOT EXISTS leader_transfers (
  transfer_id           serial PRIMARY KEY,
  from_leader_entity_id integer NOT NULL REFERENCES entities(entity_id),
  to_leader_entity_id   integer NOT NULL REFERENCES entities(entity_id),
  amount                numeric(14, 2) NOT NULL,
  note                  text,
  created_by_user_id    integer NOT NULL REFERENCES users(user_id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leader_transfers_from_idx ON leader_transfers (from_leader_entity_id);
CREATE INDEX IF NOT EXISTS leader_transfers_to_idx   ON leader_transfers (to_leader_entity_id);
CREATE INDEX IF NOT EXISTS leader_transfers_created_idx ON leader_transfers (created_at);

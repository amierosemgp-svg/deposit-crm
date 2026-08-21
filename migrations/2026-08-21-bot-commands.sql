-- On-demand agent commands — "go and crawl the banks now".
--
-- The agent sweeps the banks on its own cycle. This queue is for when that
-- cycle is too slow: a player says they've paid, CS presses Crawl banks on the
-- Deposits page, and the agent looks now instead of at the next sweep.
--
-- Shaped like game_transfers: poll for pending, claim into running, report
-- completed/failed. No money rides on it — a failed command costs nothing but
-- the wait until the scheduled sweep.
--
-- expires_at is the important column. A crawl requested at 09:00 must not fire
-- at 14:00 when the agent finally comes back up: by then the sweep has covered
-- it and nobody is waiting on it any more. Unclaimed commands past expires_at
-- are swept to "expired" on the CRM's state poll and whenever an agent polls.

DO $$ BEGIN
  CREATE TYPE bot_command AS ENUM ('crawl_bank');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bot_command_status AS ENUM (
    'pending', 'running', 'completed', 'failed', 'expired'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS bot_commands (
  command_id            serial PRIMARY KEY,
  command               bot_command NOT NULL,
  status                bot_command_status NOT NULL DEFAULT 'pending',
  -- NULL = every active deposit account in scope.
  bank_account_id       integer REFERENCES bank_accounts (account_id),
  -- NULL = unscoped (super admin with no company selected) — crawl everything.
  company_entity_id     integer REFERENCES entities (entity_id),
  requested_by_user_id  integer REFERENCES users (user_id),
  bot_id                varchar(80),
  result                jsonb,
  error                 text,
  expires_at            timestamptz NOT NULL,
  claimed_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- The agent's poll: open commands, oldest first.
CREATE INDEX IF NOT EXISTS bot_commands_open_idx
  ON bot_commands (status, created_at);

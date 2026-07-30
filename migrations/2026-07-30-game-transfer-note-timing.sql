-- Game transfer outcome/timing, transaction ownership, and a game-account
-- audit trail.
--
-- Additive and backward-compatible: every new column is nullable or defaulted,
-- so the currently deployed build (which selects an explicit, shorter column
-- list) keeps working while this is applied.

-- ---------- Game transfers: why it ended, when it ran, how many tries ----------

ALTER TABLE game_transfers
  ADD COLUMN IF NOT EXISTS note          text,
  ADD COLUMN IF NOT EXISTS started_at    timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1;

-- Both existing paths create a transfer already in "processing" (CS request) or
-- "completed" (bot POST), so created_at is the true start for every row so far.
UPDATE game_transfers
   SET started_at = created_at
 WHERE started_at IS NULL;

-- completed_at is deliberately NOT backfilled. We don't know when historical
-- transfers actually finished, and inventing created_at would render as
-- "took 0s". They stay null and the UI shows the end as unrecorded.

-- ---------- Assign to me: who owns this transaction ----------

ALTER TABLE game_transfers
  ADD COLUMN IF NOT EXISTS assigned_to_user_id integer REFERENCES users(user_id),
  ADD COLUMN IF NOT EXISTS assigned_at         timestamptz;

ALTER TABLE deposits
  ADD COLUMN IF NOT EXISTS assigned_to_user_id integer REFERENCES users(user_id),
  ADD COLUMN IF NOT EXISTS assigned_at         timestamptz;

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS assigned_to_user_id integer REFERENCES users(user_id),
  ADD COLUMN IF NOT EXISTS assigned_at         timestamptz;

-- The stuck-transfer sweep and the queue views both filter on status.
CREATE INDEX IF NOT EXISTS game_transfers_status_idx ON game_transfers (status);

-- ---------- Game account audit trail ----------

DO $$ BEGIN
  CREATE TYPE game_account_action AS ENUM ('added', 'updated', 'removed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS game_account_audit (
  audit_id           serial PRIMARY KEY,
  player_id          integer NOT NULL REFERENCES players(player_id),
  game_name          varchar(60) NOT NULL,
  action             game_account_action NOT NULL,
  old_game_username  varchar(120),
  new_game_username  varchar(120),
  changed_by_user_id integer REFERENCES users(user_id),
  source             transaction_source NOT NULL DEFAULT 'manual',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS game_account_audit_player_idx
  ON game_account_audit (player_id, created_at DESC);

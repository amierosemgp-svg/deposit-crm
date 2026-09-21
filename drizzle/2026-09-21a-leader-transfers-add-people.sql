-- Phase 1 of 2 — additive only, safe to run while the old code is live.
--
-- A leader settlement is between two PEOPLE, not two companies. The ends were
-- `leader` entities — which on screen are companies (Abdullah Club, ICON) — so
-- the sheet could only say "Abdullah Club paid ICON". What the desk records is
-- "Tiong paid KC".
--
-- This phase only ADDS the new columns and RELAXES the old ones, so both the
-- running code (which writes the entity columns) and the new code (which writes
-- the user columns) work against it. That removes any window where a deploy
-- half-done leaves the Leader Transfer sheet broken. Phase 2 drops the old
-- columns once the new code is confirmed live.
ALTER TABLE leader_transfers
  ADD COLUMN IF NOT EXISTS from_leader_user_id INTEGER REFERENCES users(user_id),
  ADD COLUMN IF NOT EXISTS to_leader_user_id   INTEGER REFERENCES users(user_id);

ALTER TABLE leader_transfers
  ALTER COLUMN from_leader_entity_id DROP NOT NULL,
  ALTER COLUMN to_leader_entity_id   DROP NOT NULL;

CREATE INDEX IF NOT EXISTS leader_transfers_from_user_idx ON leader_transfers (from_leader_user_id);
CREATE INDEX IF NOT EXISTS leader_transfers_to_user_idx   ON leader_transfers (to_leader_user_id);

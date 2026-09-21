-- Phase 2 of 2 — run only once the new code is live and a settlement has been
-- saved successfully. Drops what the old code used.
--
-- Safe because the table held zero rows at the time of the change, so no row
-- carries an entity end that would be lost.
ALTER TABLE leader_transfers
  DROP COLUMN IF EXISTS from_leader_entity_id,
  DROP COLUMN IF EXISTS to_leader_entity_id;

ALTER TABLE leader_transfers
  ALTER COLUMN from_leader_user_id SET NOT NULL,
  ALTER COLUMN to_leader_user_id   SET NOT NULL;

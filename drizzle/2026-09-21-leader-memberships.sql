-- A leader can hold more than one company.
--
-- Vocabulary, because the column names are a word off the screen's: a `leader`
-- entity IS a company (Abdullah Club, ICON), a `company` entity is a casino
-- (Pokercity). A leader is a PERSON — a users row with role company_leader.
--
-- Until now that person sat on exactly one company, through users.entity_id, so
-- Tiong could hold Abdullah Club or ICON but never both. This table is the
-- extra companies; users.entity_id stays as the one they were created under and
-- keeps working on its own, so nothing has to be backfilled and every existing
-- login behaves exactly as before.
CREATE TABLE IF NOT EXISTS leader_memberships (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- The `leader` entity: a COMPANY on screen.
  leader_entity_id  INTEGER NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
  granted_by_user_id INTEGER REFERENCES users(user_id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per pairing; granting twice is the same grant.
  CONSTRAINT leader_memberships_unique UNIQUE (user_id, leader_entity_id)
);

CREATE INDEX IF NOT EXISTS leader_memberships_user_idx
  ON leader_memberships (user_id);
CREATE INDEX IF NOT EXISTS leader_memberships_entity_idx
  ON leader_memberships (leader_entity_id);

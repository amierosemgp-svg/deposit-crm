-- Give players a modification stamp, so the CRM can stop re-sending them.
--
-- /api/state ships every player on every poll: 2,625 rows serialise to 1.5 MB,
-- the frontend polls every 10 seconds, and that is 4.2 GB of egress per open
-- tab per working day. It put the Supabase project 713% over its 5 GB quota
-- (35.66 GB against a database of 0.03 GB) and out of its grace period.
--
-- The fix is a conditional response: the client sends the version it holds and
-- the server omits the player list when nothing has changed. That needs a
-- change signal, and players had none — no updated_at, and registration_date
-- only moves for new rows. A content hash worked but cost ~110ms of md5 per
-- poll; this makes the same check an indexed max().
--
-- A trigger rather than application code on purpose: players are written from
-- the CRM API, the agent API and one-off import scripts, and a stamp that any
-- one of those could forget to set is worse than no stamp at all — it would
-- serve stale data that looks fresh.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill to registration_date so existing rows carry a truthful stamp rather
-- than all claiming to have changed at migration time.
UPDATE players SET updated_at = registration_date
WHERE registration_date IS NOT NULL;

CREATE OR REPLACE FUNCTION players_touch_updated_at() RETURNS trigger AS $$
BEGIN
  -- Only for real changes: an UPDATE that writes identical values (a no-op
  -- save from the UI) must not invalidate every client's cached player list.
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS players_touch_updated_at ON players;
CREATE TRIGGER players_touch_updated_at
  BEFORE INSERT OR UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION players_touch_updated_at();

-- The version query is max(updated_at) + count(*); this serves the max.
CREATE INDEX IF NOT EXISTS players_updated_at_idx ON players (updated_at DESC);

-- The bot's live feed: what it's doing, as it does it.
--
-- bot_health is a single overwritten row per bot ("is it up, what step"). This
-- is the running narrative underneath it, so that when something fails at 2am
-- someone can read back what the bot was doing at the time.
--
-- Run AFTER 2026-07-30c-transfer-solving-state.sql.

DO $$ BEGIN
  CREATE TYPE bot_event_level AS ENUM ('debug', 'info', 'warn', 'error');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bot_events (
  event_id         serial PRIMARY KEY,
  bot_id           varchar(80) NOT NULL,
  level            bot_event_level NOT NULL DEFAULT 'info',
  event            varchar(80) NOT NULL,
  message          text,
  context          jsonb,
  player_id        integer REFERENCES players(player_id),
  -- Intentionally NOT foreign keys: the feed is an operational log and must
  -- never block a write or be cascaded away with the record it mentions.
  game_transfer_id integer,
  deposit_id       integer,
  withdrawal_id    integer,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Tailing the feed is `where event_id > :since order by event_id desc`.
CREATE INDEX IF NOT EXISTS bot_events_tail_idx ON bot_events (event_id DESC);
CREATE INDEX IF NOT EXISTS bot_events_bot_idx ON bot_events (bot_id, event_id DESC);
-- Filtering the feed down to one transfer, skipping the rows not about one.
CREATE INDEX IF NOT EXISTS bot_events_transfer_idx
  ON bot_events (game_transfer_id, event_id DESC)
  WHERE game_transfer_id IS NOT NULL;

-- Pre-registered game accounts, waiting to be handed to players.
--
-- Run AFTER 2026-07-30-game-transfer-note-timing.sql. Purely additive: a new
-- table and a new enum, nothing existing is touched.

DO $$ BEGIN
  CREATE TYPE pool_account_status AS ENUM ('available', 'assigned', 'retired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS game_account_pool (
  pool_id            serial PRIMARY KEY,
  game_name          varchar(60) NOT NULL,
  game_username      varchar(120) NOT NULL,
  game_password      varchar(120),
  company_entity_id  integer REFERENCES entities(entity_id),
  status             pool_account_status NOT NULL DEFAULT 'available',
  assigned_player_id integer REFERENCES players(player_id),
  assigned_at        timestamptz,
  note               text,
  source             transaction_source NOT NULL DEFAULT 'bot',
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- The same provider account must never enter the pool twice; that is how two
  -- players end up sharing one game id and one balance.
  CONSTRAINT game_account_pool_game_username_key UNIQUE (game_name, game_username)
);

-- Claiming an account filters on (game_name, status) and takes the oldest row.
CREATE INDEX IF NOT EXISTS game_account_pool_available_idx
  ON game_account_pool (game_name, status, pool_id);

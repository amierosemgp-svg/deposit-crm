-- Referral system: upline/downline, and the 20% first-deposit bonus.
--
-- Additive: a nullable column on players and one new table.

-- ---------- Who referred whom ----------

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS upline_player_id   integer REFERENCES players(player_id),
  ADD COLUMN IF NOT EXISTS upline_assigned_at timestamptz;

-- Listing a player's downlines is `where upline_player_id = ?`.
CREATE INDEX IF NOT EXISTS players_upline_idx
  ON players (upline_player_id)
  WHERE upline_player_id IS NOT NULL;

-- ---------- The bonus ----------

DO $$ BEGIN
  CREATE TYPE referral_bonus_status AS ENUM ('pending', 'assigned', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS referral_bonuses (
  bonus_id            serial PRIMARY KEY,
  upline_player_id    integer NOT NULL REFERENCES players(player_id),
  downline_player_id  integer NOT NULL REFERENCES players(player_id),
  deposit_id          integer REFERENCES deposits(deposit_id),
  deposit_amount      numeric(12,2) NOT NULL,
  bonus_percentage    numeric(5,2) NOT NULL DEFAULT 20,
  bonus_amount        numeric(12,2) NOT NULL,
  status              referral_bonus_status NOT NULL DEFAULT 'pending',
  game_name           varchar(60),
  skip_bot            boolean NOT NULL DEFAULT false,
  game_transfer_id    integer,
  assigned_by_user_id integer REFERENCES users(user_id),
  assigned_at         timestamptz,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- One first-deposit bonus per downline, ever. This is what stops a
  -- re-completed or duplicated deposit minting a second payout.
  CONSTRAINT referral_bonuses_downline_key UNIQUE (downline_player_id)
);

-- The Recommend Bonus tab reads one upline's bonuses newest-first.
CREATE INDEX IF NOT EXISTS referral_bonuses_upline_idx
  ON referral_bonuses (upline_player_id, bonus_id DESC);

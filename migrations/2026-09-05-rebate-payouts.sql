-- Rebate payouts: rebates paid from a generated list, not on a deposit.
--
-- A rebate is a share of what a player lost over a window — completed deposits
-- minus paid withdrawals between two cutoffs. Until now it was only ever paid
-- by attaching the plan to the player's *next* deposit, which meant a player
-- who stopped depositing never got it, and the window boundary was hard-wired
-- to midnight / Monday / the 1st. Now the Rebates page generates the list for
-- the latest closed window (cutoffs live in settings under `rebate_cutoffs`)
-- and each row is paid as a free credit to the player's game.
--
-- One row per plan × player × window; the unique key is what stops a second
-- "generate" from paying anyone twice. Additive: nothing existing changes.

DO $$ BEGIN
  CREATE TYPE rebate_payout_status AS ENUM ('pending', 'paid', 'skipped');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS rebate_payouts (
  payout_id             serial PRIMARY KEY,
  plan_id               integer NOT NULL REFERENCES bonus_plans(plan_id),
  player_id             integer NOT NULL REFERENCES players(player_id),
  company_entity_id     integer REFERENCES entities(entity_id),
  period                bonus_period NOT NULL,

  -- The window the loss was measured over: [window_start, window_end).
  window_start          timestamptz NOT NULL,
  window_end            timestamptz NOT NULL,

  deposits_total        numeric(12,2) NOT NULL DEFAULT 0,
  withdrawals_total     numeric(12,2) NOT NULL DEFAULT 0,
  -- deposits_total - withdrawals_total, snapshotted at generate time.
  net_loss              numeric(12,2) NOT NULL,
  percentage            numeric(5,2) NOT NULL,
  amount                numeric(12,2) NOT NULL,

  status                rebate_payout_status NOT NULL DEFAULT 'pending',

  -- Where the credit goes. Suggested at generate time (the game the player
  -- lost most on), confirmable at pay time.
  game_name             varchar(60),
  game_username         varchar(120),
  -- True when CS credited the game by hand; false = the agent was asked to.
  skip_bot              boolean NOT NULL DEFAULT false,
  game_transfer_id      integer,
  -- The free-credit ledger row (transactions.game_topup) written at pay time.
  transaction_id        integer,

  generated_by_user_id  integer REFERENCES users(user_id),
  generated_at          timestamptz NOT NULL DEFAULT now(),
  paid_by_user_id       integer REFERENCES users(user_id),
  paid_at               timestamptz,
  note                  text,

  CONSTRAINT rebate_payouts_plan_player_window_key UNIQUE (plan_id, player_id, window_start)
);

CREATE INDEX IF NOT EXISTS rebate_payouts_plan_window_idx
  ON rebate_payouts (plan_id, window_start DESC);

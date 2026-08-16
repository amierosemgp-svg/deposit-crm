-- Bonus plans: a named, validated bonus in place of a bare percentage.
--
-- Until now a deposit's bonus was whatever percentage CS picked out of the
-- `bonus_options` settings list — nothing recorded WHICH bonus it was, so
-- nothing could check whether the player was entitled to it. This adds the
-- plan itself and the link from a deposit to the plan it used, which is what
-- makes "once per day/week/month" and "first deposit only" answerable.
--
-- Additive: one new table and three nullable columns on deposits. A deposit
-- with no plan is still valid — that's an ad-hoc percentage, the old behaviour.

DO $$ BEGIN
  CREATE TYPE bonus_plan_type AS ENUM ('welcome', 'recurring', 'rebate');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE bonus_period AS ENUM ('daily', 'weekly', 'monthly');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bonus_plans (
  plan_id           serial PRIMARY KEY,
  name              varchar(80) NOT NULL,
  type              bonus_plan_type NOT NULL,

  -- How often it may be claimed. Null for 'welcome', which is once ever.
  period            bonus_period,

  percentage        numeric(5,2) NOT NULL,

  -- Gate on the deposit being made. 0 = no minimum.
  min_deposit       numeric(12,2) NOT NULL DEFAULT 0,

  -- Rebate only: how much the player must be down over the period before the
  -- rebate is offered at all. 0 = any loss qualifies.
  min_loss          numeric(12,2) NOT NULL DEFAULT 0,

  -- Null = offered to every company. Set to reserve the plan to one company.
  company_entity_id integer REFERENCES entities(entity_id),

  status            active_status NOT NULL DEFAULT 'active',
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- A recurring/rebate plan without a period has no claim window, and a
  -- welcome plan with one would imply it repeats. Neither is meaningful.
  CONSTRAINT bonus_plans_period_ck CHECK (
    (type = 'welcome' AND period IS NULL) OR (type <> 'welcome' AND period IS NOT NULL)
  ),

  -- Two plans of the same name in one scope is a CS trap, not a feature.
  -- NULLS NOT DISTINCT because the house-wide plans are exactly the ones with a
  -- null company: under the default rule every one of them counts as unique
  -- from every other, so the constraint would never fire where it matters.
  CONSTRAINT bonus_plans_name_scope_key UNIQUE NULLS NOT DISTINCT (name, company_entity_id)
);

-- ---------- The link from a deposit to the plan it used ----------

ALTER TABLE deposits
  ADD COLUMN IF NOT EXISTS bonus_plan_id         integer REFERENCES bonus_plans(plan_id),
  -- Set when a leader/admin forced a bonus the player did not qualify for.
  ADD COLUMN IF NOT EXISTS bonus_override_reason text,
  -- Rebate only: the net loss the rebate was calculated from, snapshotted so a
  -- later deposit or withdrawal can never rewrite what was already paid out.
  ADD COLUMN IF NOT EXISTS bonus_basis_amount    numeric(12,2);

-- The eligibility check is "has this player used this plan since <date>" — one
-- index serves both that and the per-player bonus history.
CREATE INDEX IF NOT EXISTS deposits_bonus_plan_idx
  ON deposits (player_id, bonus_plan_id, deposit_date DESC)
  WHERE bonus_plan_id IS NOT NULL;

-- Net loss over a period sums a player's completed deposits and paid
-- withdrawals by date; both scans are per-player and time-bounded.
CREATE INDEX IF NOT EXISTS deposits_player_date_idx
  ON deposits (player_id, deposit_date DESC);
CREATE INDEX IF NOT EXISTS withdrawals_player_paid_idx
  ON withdrawals (player_id, paid_at DESC);

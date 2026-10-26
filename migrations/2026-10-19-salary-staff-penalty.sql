-- Staff pay: work hours, salary tiers, salaries, adjustments and staff penalties.
--
-- Salary used to be a category on `expenses`: an amount typed by hand, naming no
-- one. Now:
--
--   work_sessions      a CS agent's signed-in, active time — opened on sign-in,
--                      closed on sign-out or after five idle minutes. Hours and
--                      days worked are read from here.
--   salary_tiers       a casino's ladder: reach the hours and days, get the rung.
--   staff_tier_rates   what a rung pays one person, when not the rung's default.
--   staff_penalties    a CS's share of credit the house lost through their mistake.
--   salary_payments    one month's pay for one CS, every figure frozen at pay time.
--   salary_adjustments bonus / deduction / penalty / carry, pending until the next
--                      salary claims them.
--
-- Old salary expenses stay where they are, as history.
--
-- Additive: new enums, new tables, two enum values. Nothing existing is touched.
-- The two ALTER TYPE lines must run outside a transaction block on Postgres < 12.

ALTER TYPE audit_type ADD VALUE IF NOT EXISTS 'salary';
ALTER TYPE activity_category ADD VALUE IF NOT EXISTS 'payroll';

CREATE TYPE work_session_end AS ENUM ('logout', 'idle', 'replaced');
CREATE TYPE salary_basis AS ENUM ('monthly', 'hourly');
CREATE TYPE staff_penalty_source AS ENUM ('deposit', 'free_credit', 'game_transfer', 'withdrawal', 'other');
CREATE TYPE staff_penalty_status AS ENUM ('active', 'void');
CREATE TYPE salary_status AS ENUM ('paid', 'reversed');
CREATE TYPE salary_adjustment_kind AS ENUM ('bonus', 'deduction', 'penalty', 'carry');

CREATE TABLE work_sessions (
  session_id     serial PRIMARY KEY,
  user_id        integer NOT NULL REFERENCES users(user_id),
  started_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  end_reason     work_session_end
);

CREATE TABLE salary_tiers (
  tier_id            serial PRIMARY KEY,
  company_entity_id  integer NOT NULL REFERENCES entities(entity_id),
  name               varchar(60) NOT NULL,
  min_hours          numeric(7,2) NOT NULL DEFAULT 0,
  min_days           integer NOT NULL DEFAULT 0,
  basis              salary_basis NOT NULL DEFAULT 'monthly',
  default_amount     numeric(12,2) NOT NULL DEFAULT 0,
  status             active_status NOT NULL DEFAULT 'active',
  created_by_user_id integer REFERENCES users(user_id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_tier_rates (
  user_id            integer NOT NULL REFERENCES users(user_id),
  tier_id            integer NOT NULL REFERENCES salary_tiers(tier_id),
  amount             numeric(12,2) NOT NULL,
  updated_by_user_id integer REFERENCES users(user_id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tier_id)
);

CREATE TABLE staff_penalties (
  penalty_id          serial PRIMARY KEY,
  user_id             integer NOT NULL REFERENCES users(user_id),
  company_entity_id   integer NOT NULL REFERENCES entities(entity_id),
  source_type         staff_penalty_source NOT NULL,
  source_id           integer,
  player_id           integer REFERENCES players(player_id),
  occurred_at         timestamptz NOT NULL,
  credit_injected     numeric(12,2) NOT NULL,
  credit_retrieved    numeric(12,2) NOT NULL DEFAULT 0,
  loss_amount         numeric(12,2) NOT NULL,
  share_pct           numeric(5,2) NOT NULL,
  amount              numeric(12,2) NOT NULL,
  reason              varchar(200) NOT NULL,
  notes               text,
  status              staff_penalty_status NOT NULL DEFAULT 'active',
  voided_at           timestamptz,
  voided_by_user_id   integer REFERENCES users(user_id),
  recorded_by_user_id integer NOT NULL REFERENCES users(user_id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE salary_payments (
  salary_id                serial PRIMARY KEY,
  user_id                  integer NOT NULL REFERENCES users(user_id),
  company_entity_id        integer NOT NULL REFERENCES entities(entity_id),
  period_month             varchar(7) NOT NULL,
  hours_worked             numeric(7,2) NOT NULL,
  days_worked              integer NOT NULL,
  tier_id                  integer REFERENCES salary_tiers(tier_id),
  tier_name                varchar(60),
  tier_basis               salary_basis,
  tier_rate                numeric(12,2),
  base_amount              numeric(12,2) NOT NULL,
  adjustments_total        numeric(12,2) NOT NULL DEFAULT 0,
  net_amount               numeric(12,2) NOT NULL,
  carried_forward          numeric(12,2) NOT NULL DEFAULT 0,
  paid_from_account_id     integer REFERENCES bank_accounts(account_id),
  paid_from_cash_entity_id integer REFERENCES entities(entity_id),
  paid_at                  timestamptz NOT NULL DEFAULT now(),
  status                   salary_status NOT NULL DEFAULT 'paid',
  reversed_at              timestamptz,
  reversed_by_user_id      integer REFERENCES users(user_id),
  notes                    text,
  recorded_by_user_id      integer NOT NULL REFERENCES users(user_id),
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- One paid salary per person per month; a reversed one steps aside.
CREATE UNIQUE INDEX salary_payments_user_month_paid_key
  ON salary_payments (user_id, period_month) WHERE status = 'paid';

CREATE TABLE salary_adjustments (
  adjustment_id          serial PRIMARY KEY,
  user_id                integer NOT NULL REFERENCES users(user_id),
  company_entity_id      integer NOT NULL REFERENCES entities(entity_id),
  kind                   salary_adjustment_kind NOT NULL,
  amount                 numeric(12,2) NOT NULL,
  reason                 varchar(200) NOT NULL,
  occurred_at            timestamptz NOT NULL,
  penalty_id             integer REFERENCES staff_penalties(penalty_id),
  carried_from_salary_id integer REFERENCES salary_payments(salary_id),
  salary_id              integer REFERENCES salary_payments(salary_id),
  created_by_user_id     integer REFERENCES users(user_id),
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- The CS share of a staff penalty. A setting, so it can change without a deploy;
-- each penalty snapshots the share it was charged at.
INSERT INTO settings (key, value) VALUES ('staff_penalty_share_pct', '50')
  ON CONFLICT (key) DO NOTHING;

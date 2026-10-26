-- Staff pay: base salary + attendance instead of the tier ladder.
--
-- The salary ladders (hours and days → rung) are retired for CS pay (22 Oct).
-- A CS now has one monthly base salary; the month's days off move it:
--
--   staff_base_salaries  one base per CS.
--   staff_day_marks      a leader's word on a day: the day off was told
--                        ("notified"), or a day with time on the clock still
--                        counts as off ("not_notified", or "notified" =
--                        emergency leave).
--   salary_payments      + attendance_amount, attendance (frozen at pay time).
--   salary_adjustment_kind + 'advance' — salary paid early, the only thing that
--                        can take a salary below zero.
--
-- Additive: new enum, two tables, two columns, one enum value. salary_tiers and
-- staff_tier_rates stay as history; past payslips point at them.
-- The ALTER TYPE line must run outside a transaction block on Postgres < 12.

ALTER TYPE salary_adjustment_kind ADD VALUE IF NOT EXISTS 'advance';

CREATE TYPE staff_day_mark AS ENUM ('notified', 'not_notified');

CREATE TABLE staff_base_salaries (
  user_id integer PRIMARY KEY REFERENCES users(user_id),
  amount numeric(12, 2) NOT NULL,
  updated_by_user_id integer REFERENCES users(user_id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_day_marks (
  user_id integer NOT NULL REFERENCES users(user_id),
  day varchar(10) NOT NULL,
  mark staff_day_mark NOT NULL,
  note varchar(200),
  marked_by_user_id integer REFERENCES users(user_id),
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

ALTER TABLE salary_payments
  ADD COLUMN attendance_amount numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN attendance jsonb;

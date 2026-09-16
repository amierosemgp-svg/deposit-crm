-- New deposits and withdrawals are manual and skip the agent by default.
--
-- The agent picks its work off `skip_bot = false` (api/bot/transactions), so
-- flipping the default takes every new row out of its queue: a human approves,
-- tops up and pays, and nothing moves on its own. This is the state to be in
-- while a company is onboarding — RajaClub has no agent configured, and an
-- imported month of history should not start being acted on.
--
-- `deposits.source` flips with it. It defaulted to 'bot' because the agent was
-- the only thing that inserted without naming a source; now that the default
-- path is a person, an unnamed source is a person. The agent's own insert
-- (api/bot/transactions) states 'bot' explicitly so it stays labelled
-- correctly either way.
--
-- Defaults only. No existing row changes: anything already in flight keeps the
-- handling it was created with, and the agent keeps working the rows it
-- already owns. To go back, set the three defaults to their previous values —
-- 'bot', false, false.

ALTER TABLE deposits    ALTER COLUMN source   SET DEFAULT 'manual';
ALTER TABLE deposits    ALTER COLUMN skip_bot SET DEFAULT true;
ALTER TABLE withdrawals ALTER COLUMN skip_bot SET DEFAULT true;

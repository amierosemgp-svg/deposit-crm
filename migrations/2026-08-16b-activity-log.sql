-- The system log: who did what, for everything the money ledger doesn't cover.
--
-- `transactions` records money moving and nothing else — every row joins a
-- player and carries an amount. So the entire administrative surface (users,
-- entities, settings, bonuses, bank accounts, kiosks, API keys, sign-ins) has
-- until now left no trace at all: 21 mutating routes wrote nothing anywhere.
-- This is where those land.
--
-- Deliberately NOT a second copy of the ledger. The System Log page reads this
-- table, `transactions` and `bot_events` together; each action is written once,
-- to whichever of the three owns it.

DO $$ BEGIN
  CREATE TYPE activity_category AS ENUM (
    'auth',          -- sign in/out, password changes, rejected sign-ins
    'user',          -- staff accounts
    'entity',        -- the leader/company/CS tree
    'player',        -- player records
    'bank_account',
    'kiosk',         -- provider back-office logins
    'bonus',         -- the bonus catalogue
    'api_key',
    'settings',
    'expense',
    'other'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS activity_log (
  log_id            serial PRIMARY KEY,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  category          activity_category NOT NULL,

  -- Machine tag, dotted: "bonus.updated", "auth.login_failed", "user.deleted".
  -- Free text rather than an enum so a new action never needs a migration.
  action            varchar(60) NOT NULL,

  -- The line a person reads. Written at the time, in the words that were true
  -- then — a renamed company still reads correctly a year later.
  summary           text NOT NULL,

  -- Who did it. Null when there is no user: a rejected sign-in, or the system.
  actor_user_id     integer REFERENCES users(user_id),
  -- Their name as text, for when actor_user_id can't carry it: the username
  -- someone tried to sign in as, or a deleted account.
  actor_label       varchar(120),

  -- Which company the action touched. Null = system-wide (settings, API keys),
  -- which only the super admin sees.
  company_entity_id integer REFERENCES entities(entity_id),

  -- What was acted on. Not a foreign key: the row it points at may be deleted,
  -- and the log has to outlive it.
  target_type       varchar(40),
  target_id         integer,
  target_label      varchar(120),

  -- Field-level diff for edits: [{ "field": "percentage", "from": 10, "to": 12 }].
  -- An audit that only says "updated" answers nothing.
  changes           jsonb,

  -- Anything else worth keeping: IP and user agent on sign-ins, counts on bulk
  -- actions, the reason on an override.
  context           jsonb
);

-- The page reads newest-first, optionally narrowed by category, actor, or
-- company. Every filter is a prefix of one of these.
CREATE INDEX IF NOT EXISTS activity_log_occurred_idx
  ON activity_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_category_idx
  ON activity_log (category, occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_actor_idx
  ON activity_log (actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_company_idx
  ON activity_log (company_entity_id, occurred_at DESC)
  WHERE company_entity_id IS NOT NULL;

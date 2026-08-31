-- Players → People (global identity) + Members (per-company) + lead lists.
--
-- Approach: the existing `players` table IS the member table (keeps player_id,
-- so all money FKs stay valid). We add `people` above it, per-company account
-- tables beside it, and the lead-list / distribution tables. Phase 1 is
-- additive + backfill; the app keeps reading `players` exactly as before.
--
-- Migration rule (locked): keep separate, flag for review. Never auto-merge by
-- phone. One person per existing player; phone collisions / blanks get
-- needs_review = true for a human to reconcile.

-- ── 1. people ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS people (
  person_id         serial PRIMARY KEY,
  contact_number    varchar(40) UNIQUE,
  full_name         varchar(120) NOT NULL,
  telegram_username varchar(80),
  wechat_id         varchar(80),
  needs_review      boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- lead lists / leads / distributions
CREATE TABLE IF NOT EXISTS lead_lists (
  list_id                 serial PRIMARY KEY,
  owner_leader_entity_id  integer NOT NULL REFERENCES entities(entity_id),
  name                    varchar(120) NOT NULL,
  prefix                  varchar(16) NOT NULL,
  next_seq                integer NOT NULL DEFAULT 1,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS list_leads (
  lead_id    serial PRIMARY KEY,
  list_id    integer NOT NULL REFERENCES lead_lists(list_id),
  person_id  integer NOT NULL REFERENCES people(person_id),
  lead_code  varchar(40) NOT NULL,
  seq        integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT list_leads_person_key UNIQUE (list_id, person_id),
  CONSTRAINT list_leads_seq_key    UNIQUE (list_id, seq)
);
CREATE TABLE IF NOT EXISTS list_distributions (
  dist_id      serial PRIMARY KEY,
  list_id      integer NOT NULL REFERENCES lead_lists(list_id),
  to_entity_id integer NOT NULL REFERENCES entities(entity_id),
  prefix       varchar(16) NOT NULL,
  next_seq     integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT list_distributions_key UNIQUE (list_id, to_entity_id)
);

-- ── 2. players gains identity + list-origin columns ───────────────────────
ALTER TABLE players ADD COLUMN IF NOT EXISTS person_id     integer REFERENCES people(person_id);
ALTER TABLE players ADD COLUMN IF NOT EXISTS source_dist_id integer REFERENCES list_distributions(dist_id);

-- ── 3. member account tables ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS member_bank_accounts (
  id                serial PRIMARY KEY,
  member_id         integer NOT NULL REFERENCES players(player_id),
  company_entity_id integer NOT NULL REFERENCES entities(entity_id),
  bank_name         varchar(60) NOT NULL,
  account_number    varchar(60) NOT NULL,
  account_holder    varchar(120) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member_game_accounts (
  id            serial PRIMARY KEY,
  member_id     integer NOT NULL REFERENCES players(player_id),
  game_name     varchar(60) NOT NULL,
  game_username varchar(120) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 4. backfill people — one per existing player, never merged ────────────
-- A person row per player. Where two players share an exact phone, only the
-- first claims the number (the UNIQUE); the rest get NULL contact_number and a
-- review flag, so nothing is silently merged and the duplicate is visible.
WITH ranked AS (
  SELECT player_id,
         full_name,
         nullif(trim(contact_number), '') AS phone,
         telegram_username,
         wechat_id,
         row_number() OVER (
           PARTITION BY lower(nullif(trim(contact_number), ''))
           ORDER BY player_id
         ) AS rn
  FROM players
  WHERE person_id IS NULL
)
INSERT INTO people (contact_number, full_name, telegram_username, wechat_id, needs_review)
SELECT
  CASE WHEN phone IS NOT NULL AND rn = 1 THEN phone ELSE NULL END,
  full_name, telegram_username, wechat_id,
  -- flag: no phone, or a duplicate phone that couldn't claim the number.
  (phone IS NULL OR rn > 1)
FROM ranked
RETURNING person_id;

-- Link each player to its person. The insert above preserved player order, but
-- match explicitly rather than by insert order: first by claimed phone, then
-- the leftovers (blank/dup) one-to-one by player_id.
UPDATE players p
SET person_id = ppl.person_id
FROM people ppl
WHERE p.person_id IS NULL
  AND ppl.contact_number IS NOT NULL
  AND lower(ppl.contact_number) = lower(nullif(trim(p.contact_number), ''));

-- Remaining players (blank/duplicate phone) — pair each to an as-yet-unused
-- review person, deterministically by id.
WITH free_people AS (
  SELECT person_id, row_number() OVER (ORDER BY person_id) AS rn
  FROM people
  WHERE needs_review = true
    AND person_id NOT IN (SELECT person_id FROM players WHERE person_id IS NOT NULL)
),
free_players AS (
  SELECT player_id, row_number() OVER (ORDER BY player_id) AS rn
  FROM players
  WHERE person_id IS NULL
)
UPDATE players p
SET person_id = fp.person_id
FROM free_players fpl
JOIN free_people fp ON fp.rn = fpl.rn
WHERE p.player_id = fpl.player_id;

-- ── 5. backfill member accounts from the jsonb blobs ──────────────────────
INSERT INTO member_bank_accounts (member_id, company_entity_id, bank_name, account_number, account_holder)
SELECT p.player_id, p.company_entity_id,
       coalesce(a->>'bank_name',''), coalesce(a->>'account_number',''), coalesce(a->>'account_holder','')
FROM players p, LATERAL jsonb_array_elements(p.bank_accounts) AS a
WHERE p.bank_accounts IS NOT NULL
  AND coalesce(a->>'account_number','') <> ''
  -- Respect the new per-company uniqueness: skip a number already taken in the
  -- company (a pre-existing duplicate); it stays in the jsonb for review.
  AND NOT EXISTS (
    SELECT 1 FROM member_bank_accounts m
    WHERE m.company_entity_id = p.company_entity_id
      AND m.account_number = a->>'account_number'
  );

INSERT INTO member_game_accounts (member_id, game_name, game_username)
SELECT p.player_id, coalesce(g->>'game_name',''), coalesce(g->>'game_username','')
FROM players p, LATERAL jsonb_array_elements(p.game_accounts) AS g
WHERE p.game_accounts IS NOT NULL
  AND coalesce(g->>'game_name','') <> ''
  AND coalesce(g->>'game_username','') <> ''
ON CONFLICT DO NOTHING;

-- ── 6. relax username uniqueness: global → per company ────────────────────
-- Member codes are unique within a company, not across the whole DB (company_A
-- and company_B can both have an "AZ0001"). Existing global-unique data already
-- satisfies the looser per-company rule.
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_username_unique;
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_username_key;
CREATE UNIQUE INDEX IF NOT EXISTS players_company_username_key
  ON players (company_entity_id, lower(username));

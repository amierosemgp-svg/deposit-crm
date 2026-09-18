-- A company can be run by more than one leader, and by different leaders over
-- time.
--
-- The tree said otherwise: entities.parent_entity_id gave every company exactly
-- one leader, forever. Three things happen in the business that it cannot
-- express — a company run jointly, a leader downgraded and their companies
-- handed on, two leaders merged.
--
-- The dangerous half was the second one. No money row stores a leader:
-- deposits, withdrawals, expenses and transactions all carry only
-- company_entity_id, and the leader is derived by walking the tree at read
-- time. So moving a company silently rewrote history — August's figures
-- followed the company to whoever held it in September, and a settlement
-- already paid no longer matched the report that justified it.
--
-- Ownership becomes its own dated record. A change closes one row and opens
-- another; nothing is ever rewritten, so "who ran this company in August"
-- stays answerable after any number of moves.
--
-- Deliberately NOT a revenue split. Two leaders on one company both manage it;
-- the money still belongs to the company, and reports group by company as they
-- always have. If shares are ever needed, a column here is the place — the
-- dating is already right.

CREATE TABLE IF NOT EXISTS company_leaders (
  id                serial PRIMARY KEY,
  company_entity_id integer NOT NULL REFERENCES entities(entity_id),
  leader_entity_id  integer NOT NULL REFERENCES entities(entity_id),
  -- Open-ended: null valid_to is the ownership in force now.
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz,
  -- The leader the company draws under in the hierarchy. Exactly one current
  -- row per company carries it, so the tree still has a spine to hang on.
  is_primary        boolean NOT NULL DEFAULT false,
  note              text,
  created_by_user_id integer REFERENCES users(user_id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_leaders_company_idx
  ON company_leaders (company_entity_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS company_leaders_leader_idx
  ON company_leaders (leader_entity_id, valid_from DESC);

-- One live row per (company, leader): a company cannot be handed to the same
-- leader twice without the first hand-off being closed.
CREATE UNIQUE INDEX IF NOT EXISTS company_leaders_current_key
  ON company_leaders (company_entity_id, leader_entity_id)
  WHERE valid_to IS NULL;

-- And exactly one of those live rows is the primary.
CREATE UNIQUE INDEX IF NOT EXISTS company_leaders_primary_key
  ON company_leaders (company_entity_id)
  WHERE valid_to IS NULL AND is_primary;

-- Backfill from the tree as it stands, open at the start.
--
-- -infinity, not the company's created_at: imported history predates the row
-- that holds it. RajaClub was created on 14 September carrying a full month of
-- August transactions, so dating ownership from created_at would leave every
-- one of those 9,037 deposits owned by nobody — and a leader asking for August
-- would be shown an empty report.
--
-- The claim being made is "as far back as this record goes, this leader ran
-- it", which is exactly true: there is no earlier owner to contradict.
INSERT INTO company_leaders (company_entity_id, leader_entity_id, valid_from, is_primary, note)
SELECT c.entity_id, c.parent_entity_id, '-infinity'::timestamptz, true,
       'Backfilled from the entity tree'
  FROM entities c
  JOIN entities l ON l.entity_id = c.parent_entity_id
 WHERE c.entity_type = 'company'
   AND l.entity_type = 'leader'
   AND NOT EXISTS (
     SELECT 1 FROM company_leaders x
      WHERE x.company_entity_id = c.entity_id AND x.valid_to IS NULL
   );

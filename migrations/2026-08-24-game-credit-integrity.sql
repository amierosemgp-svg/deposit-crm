-- Game-balance integrity: one row per player per game, credited once.
--
-- Two faults, found after a Mega888 → 918Kiss transfer showed a balance of 40
-- where the provider had 20:
--
--  1. DOUBLE CREDIT. The agent tops a game up at the provider, syncs the real
--     balance via POST /api/bot/game-credits (an absolute set), then reports
--     the deposit completed — and the CRM adds the deposit amount on top of the
--     figure that already contained it. 26 occurrences, 6 accounts, RM 260.
--
--  2. CASE-SPLIT NAMES. game_credits is keyed on (player_id, game_name) and
--     Postgres is case-sensitive, so the agent's "918kiss" and the CRM's
--     "918Kiss" became two balances for one real account.
--
-- The code fixes both going forward (lib/game-name.ts). This repairs the data
-- and adds the constraint that stops it recurring.

-- 1 ── Merge case-variant rows onto the catalogue's spelling.
--
-- Summed, not picked: a merge must never silently destroy credit. Where the
-- split was caused by fault 1 the sum is the doubled figure, and step 2 takes
-- the duplicate back off — each step stays defensible on its own.
-- Staged through a temp table on purpose: data-modifying CTEs all run against
-- one snapshot, so a DELETE and INSERT in a single statement do not see each
-- other and the insert collides with the rows being removed.
CREATE TEMP TABLE canon_merge ON COMMIT DROP AS
WITH grouped AS (
  SELECT player_id,
         lower(game_name)     AS key,
         min(game_name)       AS fallback_name,
         sum(current_balance) AS balance,
         max(last_updated_at) AS last_updated_at
  FROM game_credits
  GROUP BY player_id, lower(game_name)
  HAVING count(*) > 1
),
catalogue AS (
  SELECT c.name
  FROM settings s, jsonb_array_elements_text(s.value) AS c(name)
  WHERE s.key = 'games'
)
SELECT g.player_id, g.key, g.balance, g.last_updated_at,
       -- The catalogue spelling if it knows this game, else the variant that
       -- sorts first, so the choice is deterministic either way.
       coalesce(
         (SELECT c.name FROM catalogue c WHERE lower(c.name) = g.key LIMIT 1),
         g.fallback_name
       ) AS canonical_name
FROM grouped g;

DELETE FROM game_credits g
USING canon_merge c
WHERE g.player_id = c.player_id AND lower(g.game_name) = c.key;

INSERT INTO game_credits (player_id, game_name, current_balance, last_updated_at)
SELECT player_id, canonical_name, balance, last_updated_at FROM canon_merge;

-- 2 ── Restore each doubled balance to the provider's own figure.
--
-- Not "subtract every historical overcredit": each sync SETS the balance to
-- ground truth, wiping any earlier error, so only the top-up applied after the
-- most recent sync is still in the number. Summing them all would have written
-- 12.20 where the truth was 20.20.
--
-- So the repair is stated as an identity instead of an arithmetic guess: where
-- the stored balance is exactly (last synced figure + the top-ups booked after
-- that sync), it is the bug and the answer is the synced figure. Any row that
-- does not match that shape has had other activity since — a withdrawal, a
-- transfer — and is deliberately left alone for a human rather than guessed at.
WITH last_sync AS (
  SELECT DISTINCT ON (player_id, lower(game_name))
         player_id,
         lower(game_name)                     AS key,
         created_at                           AS synced_at,
         (details->>'balance_after')::numeric AS synced_balance
  FROM transactions
  WHERE type = 'bo_adjustment'
    AND details->>'action' = 'balance_sync'
    AND details->>'balance_after' IS NOT NULL
  ORDER BY player_id, lower(game_name), created_at DESC
),
topups_since AS (
  SELECT s.player_id, s.key, sum(t.amount) AS amount
  FROM last_sync s
  JOIN transactions t
    ON t.player_id = s.player_id
   AND lower(t.game_name) = s.key
   AND t.type = 'game_topup'
   AND t.created_at > s.synced_at
  GROUP BY s.player_id, s.key
),
repair AS (
  SELECT s.player_id, s.key, s.synced_balance
  FROM last_sync s
  JOIN topups_since ts ON ts.player_id = s.player_id AND ts.key = s.key
  JOIN game_credits g  ON g.player_id  = s.player_id AND lower(g.game_name) = s.key
  WHERE g.current_balance = s.synced_balance + ts.amount
)
UPDATE game_credits g
SET current_balance = r.synced_balance,
    last_updated_at = now()
FROM repair r
WHERE g.player_id = r.player_id
  AND lower(g.game_name) = r.key;

-- 3 ── One account per game, in the player record too.
--
-- Same ambiguity in a different table: two entries for one game means every
-- top-up and transfer has two candidate logins and takes whichever the lookup
-- returns first. Keeps the first occurrence of each game, case-insensitively.
UPDATE players p
SET game_accounts = cleaned.accounts
FROM (
  SELECT player_id,
         jsonb_agg(account ORDER BY ord) AS accounts
  FROM (
    SELECT DISTINCT ON (player_id, lower(account->>'game_name'))
           player_id, account, ord
    FROM players,
         LATERAL jsonb_array_elements(game_accounts) WITH ORDINALITY AS a(account, ord)
    WHERE game_accounts IS NOT NULL
    ORDER BY player_id, lower(account->>'game_name'), ord
  ) first_per_game
  GROUP BY player_id
) cleaned
WHERE p.player_id = cleaned.player_id
  AND p.game_accounts IS DISTINCT FROM cleaned.accounts;

-- 4 ── The backstop. game_credits' primary key is case-sensitive, so this is
-- what actually makes a second spelling impossible. A write that would split a
-- balance now fails loudly instead of quietly opening a second account.
CREATE UNIQUE INDEX IF NOT EXISTS game_credits_player_game_ci_idx
  ON game_credits (player_id, lower(game_name));

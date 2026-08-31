-- Multiple game accounts per game, each with its own balance.
--
-- A player may hold several logins under one game (different kiosk accounts).
-- game_credits was keyed on (player_id, game_name), so those logins shared one
-- balance and every top-up/pull/transfer resolved the login by game name. This
-- adds game_username to the key so each login carries its own balance, and adds
-- the target-login columns to the money-moving records.
--
-- Backfill rule: an existing balance/record with no login named belongs to the
-- player's FIRST linked account for that game (case-insensitive) — the login
-- the old single-account world would have used — or "" when the player has no
-- account for it at all.

-- 1 ── game_credits: add the column, backfill, re-key.
ALTER TABLE game_credits
  ADD COLUMN IF NOT EXISTS game_username varchar(120) NOT NULL DEFAULT '';

-- Backfill each balance row's login from the player's first account for the
-- game. DISTINCT ON keeps the earliest (lowest ordinality) account per game.
WITH first_login AS (
  SELECT DISTINCT ON (p.player_id, lower(a.account->>'game_name'))
         p.player_id,
         lower(a.account->>'game_name') AS game_key,
         a.account->>'game_username'    AS game_username
  FROM players p,
       LATERAL jsonb_array_elements(p.game_accounts) WITH ORDINALITY AS a(account, ord)
  WHERE p.game_accounts IS NOT NULL
  ORDER BY p.player_id, lower(a.account->>'game_name'), a.ord
)
UPDATE game_credits g
SET game_username = fl.game_username
FROM first_login fl
WHERE g.player_id = fl.player_id
  AND lower(g.game_name) = fl.game_key
  AND g.game_username = ''
  AND fl.game_username IS NOT NULL;

-- Re-key: drop the old (player_id, game_name) primary key and the case-
-- insensitive backstop, add the login to both.
ALTER TABLE game_credits DROP CONSTRAINT IF EXISTS game_credits_pkey;
ALTER TABLE game_credits
  ADD CONSTRAINT game_credits_pkey PRIMARY KEY (player_id, game_name, game_username);

DROP INDEX IF EXISTS game_credits_player_game_ci_idx;
CREATE UNIQUE INDEX IF NOT EXISTS game_credits_player_game_login_ci_idx
  ON game_credits (player_id, lower(game_name), lower(game_username));

-- 2 ── The money-moving records learn which login they target. All nullable:
-- existing rows predate the feature and their balance moves already happened,
-- so NULL means "the player's first account for the game" at read time.
ALTER TABLE deposits      ADD COLUMN IF NOT EXISTS selected_game_username varchar(120);
ALTER TABLE withdrawals   ADD COLUMN IF NOT EXISTS game_username          varchar(120);
ALTER TABLE game_transfers ADD COLUMN IF NOT EXISTS from_game_username    varchar(120);
ALTER TABLE game_transfers ADD COLUMN IF NOT EXISTS to_game_username      varchar(120);

-- "Transfer all": move whatever is actually in the source wallet.
--
-- The same fault "withdraw all" had before 2026-08-18-withdraw-all.sql, in the
-- one other place CS can say "all of it". The checkbox on the Game Credit
-- Transfer page never reached the database: it was resolved in the browser to
-- the *cached* game_credits figure and posted as an ordinary amount, so the
-- agent was handed a number and never told the intent behind it.
--
-- That cache lags the provider — this morning's 2026-08-24-game-credit-integrity
-- migration took RM 216 of phantom credit out of it — so "all" routinely meant
-- the wrong number in both directions: too much and the move fails at the
-- provider, too little and credit is silently left behind in the source game.
--
-- With the flag stored, the amount becomes a placeholder (0, exactly as
-- withdrawals do it) and the agent is told to empty the source wallet and
-- report back what was really there.

ALTER TABLE game_transfers
  ADD COLUMN IF NOT EXISTS transfer_all boolean NOT NULL DEFAULT false;

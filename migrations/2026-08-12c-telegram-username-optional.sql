-- Telegram handle becomes optional on players.
--
-- Players arrive from sources that have a phone number and nothing else — a
-- bulk import of an operator's existing book, for instance, where the contact
-- route is known to be Telegram but the handle was never recorded. NOT NULL
-- forced those imports to invent a handle, which is worse than an honest blank:
-- a fabricated @handle looks like a real contact and silently fails to resolve.
--
-- Readers must tolerate null. The agent's player lookups match on the handle
-- (ilike) — a null simply never matches, which is the correct behaviour for a
-- player who has no handle on record.

ALTER TABLE players
  ALTER COLUMN telegram_username DROP NOT NULL;

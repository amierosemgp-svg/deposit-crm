-- Deposit times were landing 8 hours in the future.
--
-- The agent runs on Malaysian time and sends wall-clock strings with no offset
-- ("extracted_at": "2026-06-29T13:38:04.268528"). `new Date()` reads a naive
-- string in the *server's* zone, and the server is UTC — so 21:40 MYT was
-- stored as 21:40 UTC, eight hours late.
--
-- The giveaway is that the stamps were impossible on their own terms: deposit
-- 199 claimed the money arrived at 05:40 on 21 Aug while the row recording it
-- was created at 21:41 MYT on 20 Aug. A deposit cannot land after the CRM has
-- already written it down. 99 of the 102 timed deposits are off by exactly
-- +8:00:00 from their own created_at.
--
-- lib/bot-transactions.ts now reads naive strings as MYT. This repairs what the
-- old parse wrote.

ALTER TABLE deposits
  ADD COLUMN IF NOT EXISTS deposit_time_known boolean NOT NULL DEFAULT true;

-- 1 ── Flag the date-only deposits, BEFORE anything moves.
--
-- "25 Jun 2026" carries no time; it parsed to midnight UTC, which the UI then
-- rendered as a confident "08:00" in MYT. 100 rows show that same fake clock
-- reading. They are left where they are on purpose — midnight UTC renders as
-- the correct MYT calendar day, and the deposits filter buckets on the UTC date,
-- so moving them to MYT midnight would push every one into the previous day.
-- Only the claim to know a time is withdrawn; the UI now prints the date alone.
--
-- Must run before step 2, which would otherwise land rows on midnight itself.
UPDATE deposits
SET deposit_time_known = false
WHERE (deposit_date AT TIME ZONE 'UTC')::time = '00:00:00';

-- 2 ── Move the misparsed timestamps back to the instant they describe.
--
-- Deliberately keyed on the +8h signature rather than "every bot deposit":
-- three timed rows sit at ~0h from created_at — two `manual` deposits stamped
-- by the CRM itself and one demo row — and those are already correct UTC.
-- Subtracting 8 hours from them would break what the bug never touched.
--
-- Rounding the gap to the nearest hour absorbs the scrape latency between the
-- money landing and the agent reporting it (deposit 199: 7h58m57s), while still
-- being nowhere near the ~0h cluster it must exclude.
UPDATE deposits
SET deposit_date = deposit_date - interval '8 hours'
WHERE deposit_time_known
  AND round(extract(epoch FROM (deposit_date - created_at)) / 3600) = 8;

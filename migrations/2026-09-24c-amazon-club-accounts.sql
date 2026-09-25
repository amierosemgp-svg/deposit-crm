-- The two Amazon Club accounts Pokercity paid into.
--
-- Two rows in the Clear Bank import are payments out to another company: "BACKUP TO
-- AC AFFIN" (RM 4,610.00, 6 Sep) and "BACKUP TO AC2 RHB" (RM 4,926.00, 3 Sep). They
-- are the only two backup rows in the whole import with no matching second leg — for
-- every internal move the import wrote both ends, one positive on the sending account
-- and one negative on the receiving one, and these two have no negative half because
-- the receiving account is not ours.
--
-- AC is Amazon Club, entity 11, a sibling leader under ALL Group — not Abdullah Club,
-- which is AB. The `_ac` suffix on its users (yip_ac, long_ac) is the giveaway. That
-- makes these genuinely company-to-company, which is what the client's reply to our
-- inquiry called "ctc".
--
-- AC2 is recorded here as Amazon Club's *second account*, not a second company. If it
-- turns out to be its own entity, move the row: this migration deliberately creates
-- nothing that a later `UPDATE bank_accounts SET entity_id = …` cannot fix.
--
-- `account_number` is NOT NULL and we do not have them, so both are '(unknown)'. That
-- is honest and it is visible; a made-up number would not be either. `role` is
-- 'both' to match every other account on file, and `status` is 'inactive' so neither
-- appears in a picker — nobody should be able to select these by accident, they exist
-- so that a transfer can point at them.
--
-- Additive: two rows, guarded, re-runnable.

INSERT INTO bank_accounts (entity_id, role, bank_name, account_number, account_holder, label, status)
SELECT 11, 'both', 'Affin', '(unknown)', 'Amazon Club', 'AC (Affin)', 'inactive'
WHERE NOT EXISTS (SELECT 1 FROM bank_accounts WHERE entity_id = 11 AND label = 'AC (Affin)');

INSERT INTO bank_accounts (entity_id, role, bank_name, account_number, account_holder, label, status)
SELECT 11, 'both', 'RHB', '(unknown)', 'Amazon Club 2', 'AC2 (RHB)', 'inactive'
WHERE NOT EXISTS (SELECT 1 FROM bank_accounts WHERE entity_id = 11 AND label = 'AC2 (RHB)');

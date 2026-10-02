-- A free-text remark on deposits and withdrawals, typed by the desk.
--
-- The worksheet's Remark cell was assembled on the fly — the correction trail
-- (edit_note) and the member's name — so there was nothing behind it to edit.
-- Imported rows in particular arrive with notes that had nowhere to go.
--
-- Additive and nullable: code deployed before this column exists never reads
-- it, and code after it treats null as "no remark".
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS remark text;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS remark text;

COMMENT ON COLUMN deposits.remark IS 'Free-text remark typed on the worksheet.';
COMMENT ON COLUMN withdrawals.remark IS 'Free-text remark typed on the worksheet.';

-- "Who changed this row, and what did they change?" — on the row itself.
--
-- activity_log already holds the full before/after diff, and still does: it is
-- the record an audit reads. But it is a different page, and the question gets
-- asked while looking at the sheet, about the row under the cursor. Now that a
-- completed deposit can be corrected, that question stops being occasional.
--
-- So each edit also leaves a one-line summary here — "Ah Meng: amount 500 →
-- 50" — which the worksheet shows in the Remark column. Newest first, older
-- ones kept behind it until the line is full. A summary, not the audit trail:
-- the trail is still activity_log, and this is what fits in a cell.
--
-- Additive: one nullable column on each table.

ALTER TABLE deposits    ADD COLUMN IF NOT EXISTS edit_note text;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS edit_note text;

COMMENT ON COLUMN deposits.edit_note IS
  'Human-readable trail of post-save corrections, newest first. Full diffs live in activity_log.';
COMMENT ON COLUMN withdrawals.edit_note IS
  'Human-readable trail of post-save corrections, newest first. Full diffs live in activity_log.';

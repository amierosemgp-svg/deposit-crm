-- When a deposit was approved.
--
-- Approval left no timestamp behind: the approve route only bumped updated_at,
-- which every later transition (processing, completed) then overwrote. So
-- "how long did this sit waiting for CS" — the one number the deposits queue is
-- actually judged on — was unanswerable from the deposits table.
--
-- deposit_date is when the money landed; approved_at is when a human (or the
-- agent, driving it out of pending itself) let it go. The gap between them is
-- the queue time.
--
-- Set once: the first approval wins, so processing → completed never rewrites
-- it. Cleared on reprocess, because a deposit sent back to pending really is
-- waiting on a human again.

ALTER TABLE deposits
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- Backfill from the ledger, which recorded the moment even though the deposit
-- row didn't. Two shapes, because approval has two paths:
--   * CS pressing Approve      → details.action = 'approved_dispatched'
--   * the agent driving it out → details.action = 'status_update', with
--                                from ∈ (pending, matched) and to past approval
-- Earliest such row per deposit wins, matching the set-once rule above.
--
-- Deposits approved before the ledger carried either shape stay NULL. That is
-- the honest answer — better an empty cell than a fabricated time derived from
-- updated_at, which for a completed deposit is the completion, not the approval.
UPDATE deposits d
SET approved_at = t.approved_at
FROM (
  SELECT reference_id, min(created_at) AS approved_at
  FROM transactions
  WHERE type = 'deposit'
    AND reference_id IS NOT NULL
    AND (
      details->>'action' = 'approved_dispatched'
      OR (
        details->>'action' = 'status_update'
        AND details->>'from' IN ('pending', 'matched')
        AND details->>'to'   IN ('approved', 'processing', 'completed')
      )
    )
  GROUP BY reference_id
) t
WHERE d.deposit_id = t.reference_id
  AND d.approved_at IS NULL;

-- Reports and the Deposits page both filter on an approval-date range.
CREATE INDEX IF NOT EXISTS deposits_approved_at_idx
  ON deposits (approved_at);

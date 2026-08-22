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
--
-- Only approvals that survive the deposit's LAST reprocess count. A reprocess
-- sends a failed deposit back to pending — it is waiting on a human again, and
-- the runtime clears approved_at when it happens. A backfill that ignored this
-- would paint an approval date on a deposit still sitting in the queue, and
-- drag it into every approval-date filter. Taking the newest surviving approval
-- (rather than the oldest overall) also gets a re-approved deposit right: it
-- reports the cycle it is actually in.
--
-- Within one cycle there is exactly one approval event, so "newest surviving"
-- and "the one that counts" are the same row — the set-once rule still holds.
--
-- Deposits approved before the ledger carried either shape stay NULL. That is
-- the honest answer — better an empty cell than a fabricated time derived from
-- updated_at, which for a completed deposit is the completion, not the approval.
WITH reprocessed AS (
  SELECT reference_id, max(created_at) AS at
  FROM transactions
  WHERE type = 'deposit'
    AND reference_id IS NOT NULL
    AND details->>'action' = 'reprocess'
  GROUP BY reference_id
),
approval AS (
  SELECT t.reference_id, max(t.created_at) AS at
  FROM transactions t
  LEFT JOIN reprocessed r ON r.reference_id = t.reference_id
  WHERE t.type = 'deposit'
    AND t.reference_id IS NOT NULL
    AND (
      t.details->>'action' = 'approved_dispatched'
      OR (
        t.details->>'action' = 'status_update'
        AND t.details->>'from' IN ('pending', 'matched')
        AND t.details->>'to'   IN ('approved', 'processing', 'completed')
      )
    )
    AND (r.at IS NULL OR t.created_at > r.at)
  GROUP BY t.reference_id
)
UPDATE deposits d
SET approved_at = a.at
FROM approval a
WHERE d.deposit_id = a.reference_id
  AND d.approved_at IS NULL;

-- Belt and braces, and the repair path if an earlier run of this file used the
-- reprocess-blind query above. A deposit sitting in a pre-approval status has,
-- by definition, no current approval — whatever the ledger says happened before
-- it was sent back. Idempotent: a no-op on a correctly-filled table.
UPDATE deposits
SET approved_at = NULL
WHERE approved_at IS NOT NULL
  AND status IN ('pending', 'pending_match', 'matched');

-- Reports and the Deposits page both filter on an approval-date range.
CREATE INDEX IF NOT EXISTS deposits_approved_at_idx
  ON deposits (approved_at);

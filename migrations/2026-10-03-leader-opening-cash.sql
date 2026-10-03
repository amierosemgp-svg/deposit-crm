-- The cash a leader was holding when they joined the CRM.
--
-- Bank accounts carry an opening balance and kiosks an opening credit; a
-- leader's own cash had nothing, so every settlement "from cash" or "to cash"
-- started from an amount nobody had written down. This is that amount, per
-- leader person — the leader transfer names the person, and the person is who
-- physically holds the notes.
--
-- Nullable on purpose: null is "not entered yet", which is the truth for every
-- leader created before this column, and is different from holding RM 0.
-- Additive, so the currently deployed code neither sees nor needs it.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS opening_cash numeric(14,2),
  ADD COLUMN IF NOT EXISTS opening_cash_at timestamptz;

COMMENT ON COLUMN users.opening_cash IS
  'Leaders only: cash on hand when they were onboarded. Null = not entered yet.';
COMMENT ON COLUMN users.opening_cash_at IS
  'When the opening cash was entered or last corrected.';

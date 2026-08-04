-- Backfill referral bonuses for upline links made before the reconcile fix.
--
-- The first cut only minted a bonus at deposit-completion time, so any upline
-- assigned AFTER the downline had already deposited never produced one. The
-- app now reconciles on both sides (see syncReferralBonus), but existing links
-- were never re-evaluated.
--
-- Mirrors the application rule exactly: 20% of the downline's EARLIEST
-- completed deposit, one bonus per downline. Idempotent — the unique
-- constraint on downline_player_id makes a re-run a no-op.

INSERT INTO referral_bonuses (
  upline_player_id,
  downline_player_id,
  deposit_id,
  deposit_amount,
  bonus_percentage,
  bonus_amount,
  status
)
SELECT
  p.upline_player_id,
  p.player_id,
  d.deposit_id,
  d.deposit_amount,
  20,
  round(d.deposit_amount * 0.20, 2),
  'pending'
FROM players p
JOIN LATERAL (
  SELECT deposit_id, deposit_amount
    FROM deposits
   WHERE player_id = p.player_id
     AND status = 'completed'
   ORDER BY deposit_date ASC, deposit_id ASC
   LIMIT 1
) d ON true
WHERE p.upline_player_id IS NOT NULL
ON CONFLICT (downline_player_id) DO NOTHING;

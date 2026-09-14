-- Read-only. Everything the RajaClub import and the new reports rely on.
SELECT feature, CASE WHEN ok THEN 'ok' ELSE 'MISSING' END AS state, needs FROM (VALUES
  ('players username unique PER COMPANY (not global)',
   EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='players' AND indexname='players_company_username_key')
   AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('players_username_key','players_username_unique')),
   '2026-09-01-people-members.sql'),
  ('people / member_game_accounts / member_bank_accounts',
   (SELECT count(*) FROM pg_tables WHERE schemaname='public'
      AND tablename IN ('people','member_game_accounts','member_bank_accounts')) = 3,
   '2026-09-01-people-members.sql'),
  ('players.person_id + source_dist_id',
   (SELECT count(*) FROM information_schema.columns WHERE table_name='players'
      AND column_name IN ('person_id','source_dist_id')) = 2,
   '2026-09-01-people-members.sql'),
  ('players.updated_at + touch trigger',
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='players_touch_updated_at'),
   '2026-08-27-players-updated-at.sql'),
  ('bank_cash_outs table',
   EXISTS (SELECT 1 FROM pg_tables WHERE tablename='bank_cash_outs'),
   '2026-09-05b-bank-cash-outs.sql'),
  ('audit_type has bank_cash_out / recommend_bonus / leader_transfer',
   (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
     WHERE t.typname='audit_type'
       AND e.enumlabel IN ('bank_cash_out','recommend_bonus','leader_transfer')) = 3,
   '2026-09-05b / 2026-08-12 / 2026-08-31b'),
  ('bonus_plans table',
   EXISTS (SELECT 1 FROM pg_tables WHERE tablename='bonus_plans'),
   '2026-08-16-bonus-plans.sql'),
  ('deposits.deposit_time_known',
   EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_name='deposits' AND column_name='deposit_time_known'),
   '2026-08-24c-deposit-date-myt.sql'),
  ('deposits.approved_at',
   EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_name='deposits' AND column_name='approved_at'),
   '2026-08-22-deposit-approved-at.sql'),
  ('referral_bonuses table',
   EXISTS (SELECT 1 FROM pg_tables WHERE tablename='referral_bonuses'),
   '2026-08-04-referral-system.sql'),
  ('activity_log  (--replace cleanup only)',
   EXISTS (SELECT 1 FROM pg_tables WHERE tablename='activity_log'),
   '2026-08-16b-activity-log.sql'),
  ('user_devices + auth_challenges  (--replace cleanup only)',
   (SELECT count(*) FROM pg_tables WHERE schemaname='public'
      AND tablename IN ('user_devices','auth_challenges')) = 2,
   '2026-09-12-2fa-devices-access.sql')
) AS t(feature, ok, needs)
ORDER BY ok, feature;

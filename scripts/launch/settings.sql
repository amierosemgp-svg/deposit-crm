-- Settings and bonus plans for the Pokercity launch.
--
-- The games and the operator's own spellings come from the workbook's own
-- "code" sheet, so the worksheet accepts exactly what the desk types today —
-- including "LIve22" and the " 2" suffixes they use for a second account on
-- the same kiosk.
--
-- Bonus rates are deliberately NOT all plans. The desk's everyday 5% and 10%,
-- and the 15% special, are typed into the Bonus % cell: a plan would be a
-- once-per-period rule, and in this data 339 member-days carry more than one
-- bonus (one member took 15 in a day). Only the welcome rates are plans,
-- because "once ever" is exactly what a plan enforces.

INSERT INTO settings (key, value) VALUES
  ('games', '["Mega888","Scr888","Pussy888","Rollex","Suncity","LuckyPalace","Crown","3win8","Kiss 3","Joker","XE88","Live22","918Kaya","4D","12win"]'::jsonb),
  ('banks', '["Maybank","CIMB","Hong Leong","Public Bank","RHB","BSN","Ambank","Affin","Touch n Go","GX Bank","Ryt Bank","Boost Bank","ShopeePay","BigPay","AEON Bank","MBSB Bank","Agrobank","Bank Rakyat","Bank Islam","Muamalat","Alliance","HSBC","UOB","Merchantrade","GoPayz"]'::jsonb),
  -- What the Bonus % dropdown offers: the everyday 5/10, the 15 special, the
  -- two welcome rates, and the 30 the recommend bonus pays.
  ('bonus_options', '[0,5,10,15,20,25,30]'::jsonb),
  -- Their spellings on the left, ours on the right. The " 2" names are second
  -- accounts on the same kiosk, not different games.
  ('game_aliases', '{"LIve22":"Live22","Mega 2":"Mega888","Scr888 2":"Scr888","Rollex 2":"Rollex","Pussy 2":"Pussy888","3win8 2":"3win8","Crown 2":"Crown","LuckyPalace 2":"LuckyPalace","918kiss":"Scr888"}'::jsonb),
  -- Share of a downline's first deposit that the upline earns. Their books pay
  -- 30% (9/30, 120/400, 15/50 in the Rekemen rows); the code default was 20.
  ('referral_bonus_pct', '30'::jsonb),
  -- 0 disables the house minimum. It measures the CRM's cached wallet, which
  -- is empty until the agent syncs balances — switch it on only after that.
  ('min_withdrawal_amount', '0'::jsonb),
  ('transfer_auto_confirm_hours', '24'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Welcome bonuses: claimable on a member's first deposit ever, and only one of
-- them, because both are gated on that same first deposit.
INSERT INTO bonus_plans (name, type, period, percentage, min_deposit, notes) VALUES
  ('Welcome 20%', 'welcome', NULL, 20, 0, 'First deposit only, once ever.'),
  ('Welcome 25%', 'welcome', NULL, 25, 0, 'First deposit only, once ever.')
ON CONFLICT (name, company_entity_id) DO NOTHING;

-- Move existing referral-bonus ledger rows onto the new type.
--
-- Run AFTER 2026-08-12-recommend-bonus-type.sql has committed.
--
-- Two shapes to catch, one per assignment path:
--   1. skip_bot — CS credited by hand, booked at assign time as `game_topup`.
--   2. queued   — the agent carried it as a game transfer whose from and to
--                 game are the same (a credit-in, not a move).
-- Both are identified precisely, so an ordinary top-up or a real game-to-game
-- transfer is never touched.

UPDATE transactions
SET type = 'recommend_bonus'
WHERE type = 'game_topup'
  AND details ->> 'action' = 'referral_bonus_assigned';

UPDATE transactions t
SET type      = 'recommend_bonus',
    -- "Mega888 → Mega888" reads as a move that went nowhere; a credit-in is
    -- just the game it landed in.
    game_name = gt.to_game
FROM game_transfers gt
WHERE t.type = 'game_transfer'
  AND t.reference_id = gt.transfer_id
  AND gt.from_game = gt.to_game
  -- Only the row that recorded credit actually landing. The same transfer also
  -- accumulates 'solving' and 'failed' rows from the stall sweep; those record
  -- retry attempts, not payment, and retyping them would make one unpaid bonus
  -- read as three payouts in the history.
  AND t.details ->> 'action' = 'completed';

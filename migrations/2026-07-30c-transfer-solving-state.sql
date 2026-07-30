-- The "solving" state: a transfer the recovery sweep re-queued after the bot
-- went quiet on it.
--
--   pending (Initializing) ──bot claims──▶ processing ──▶ completed
--      ▲                                       │      └──▶ failed
--      └──────────── solving ◀───── stalled ───┘
--
-- Run AFTER 2026-07-30b-game-account-pool.sql.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot be used in the same transaction that
-- then writes the new value. Run this file on its own (psql -f, which is
-- autocommit) — do NOT wrap it in BEGIN/COMMIT with -1.

ALTER TYPE game_transfer_status ADD VALUE IF NOT EXISTS 'solving' AFTER 'pending';

-- Transfers already in flight were created straight into "processing" under the
-- old two-state flow. They are left exactly as they are: "processing" is still
-- a valid, meaningful state, and the sweep will pick up any that are stalled.

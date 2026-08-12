-- A dedicated ledger type for referral payouts.
--
-- Referral bonuses were booked as `game_topup`, which is also what a normal
-- deposit top-up writes — so bonus spend could not be totalled without digging
-- through the details JSON. This splits them out.
--
-- Run this file on its own: Postgres will not let a new enum value be USED in
-- the same transaction that adds it, so the backfill lives in
-- 2026-08-12b-backfill-recommend-bonus.sql and must run after this commits.

ALTER TYPE audit_type ADD VALUE IF NOT EXISTS 'recommend_bonus';

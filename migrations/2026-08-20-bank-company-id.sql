-- Corporate banking logins need a company ID.
--
-- A personal account signs in with user ID + password; an enterprise account
-- (Maybank2u Biz, CIMB BizChannel and friends) asks for the company/organisation
-- ID first, then the user ID under it. Without this the agent cannot reach the
-- first screen on those accounts.
--
-- Nullable: personal accounts have no such thing, and most rows are personal.

ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS login_company_id varchar(80);

-- Which device a bank account's banking app is bound to.
--
-- Banks tie an online-banking login to one registered device, so when a
-- balance stops updating the first question is which device was on it. The bot
-- reports this as it picks the account up.
--
-- Additive and nullable: the currently deployed build ignores it.

ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS device_id varchar(120);

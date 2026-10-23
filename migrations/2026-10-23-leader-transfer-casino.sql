-- Which casino each end of a leader transfer is for.
--
-- A leader can hold many casinos (Jeffery OK sits on seven groups), and a
-- settlement was shown to every group either person belonged to — so a
-- Fishingstar payment to Jeffery appeared on Bonus Bear's sheet. The desk now
-- picks the casino each end is for, and the row is shown to those casinos.
--
-- Additive and nullable: old rows keep null and stay visible as before; code
-- deployed before these columns exist never reads them.
ALTER TABLE leader_transfers
  ADD COLUMN IF NOT EXISTS from_company_entity_id integer REFERENCES entities(entity_id),
  ADD COLUMN IF NOT EXISTS to_company_entity_id integer REFERENCES entities(entity_id);

COMMENT ON COLUMN leader_transfers.from_company_entity_id IS 'Casino the sending end is for; null = not recorded (visible to every group of the leader).';
COMMENT ON COLUMN leader_transfers.to_company_entity_id IS 'Casino the receiving end is for; null = not recorded (visible to every group of the leader).';

-- Worksheet rows can be corrected after they are saved, so the activity log
-- needs somewhere to file the correction.
--
-- The existing categories cover the things CS *configures* — players, kiosks,
-- bank accounts, bonuses. A deposit or withdrawal being edited is neither of
-- those, and filing it under "other" would bury the one kind of change
-- somebody goes looking for: who changed this figure, and what did it say
-- before.
--
-- Additive: one enum value. Nothing existing changes.

ALTER TYPE activity_category ADD VALUE IF NOT EXISTS 'transaction';

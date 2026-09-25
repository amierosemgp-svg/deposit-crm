-- Where a wrongly-imported Clear Bank row went, and what it looked like before.
--
-- The Clear Bank tab does not exist in the client's own workbook. It was created
-- here by an import run in September, and that import swept in everything it could
-- not otherwise place: internal transfers between our own accounts, a company-to-
-- company payment, money the boss had put in himself. Every one of those rows
-- carries `Clear Bank — imported row PC-C-NNN` in its notes; the genuine rows, keyed
-- by a human, carry a human note instead.
--
-- Putting each row where it belongs means it must leave `bank_cash_outs`, because a
-- row that stays there keeps debiting its account. Deleting it outright would throw
-- away the only record of what the import actually did, which is the one thing worth
-- keeping when the numbers are later checked against the client's workbook.
--
-- So the row is copied here whole — the original as jsonb, not a set of columns, so
-- this table never has to be migrated again when `bank_cash_outs` changes — together
-- with what it became. Reversing a relocation is then: insert the jsonb back, delete
-- the destination row, delete the relocation.
--
-- `destination_kind` is text, not an enum, because the next import mistake will land
-- somewhere this migration has not thought of and a failed insert is a worse outcome
-- than an unvalidated string.
--
-- Additive: one table. Nothing existing is touched by this file.

CREATE TABLE cash_out_relocations (
  relocation_id    serial PRIMARY KEY,
  cash_out_id      integer NOT NULL,          -- the id it had; no FK, the row is gone
  original         jsonb   NOT NULL,          -- the whole bank_cash_outs row as it was
  destination_kind text    NOT NULL,          -- 'bank_transfer' | 'claim' | 'withdrawal' | ...
  destination_id   integer,                   -- id in that table; null if it was only removed
  reason           text    NOT NULL,          -- why this row did not belong in Clear Bank
  batch            varchar(60) NOT NULL,      -- which clean-up run did it
  relocated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cash_out_relocations_cash_out_idx ON cash_out_relocations (cash_out_id);
CREATE INDEX cash_out_relocations_batch_idx ON cash_out_relocations (batch);

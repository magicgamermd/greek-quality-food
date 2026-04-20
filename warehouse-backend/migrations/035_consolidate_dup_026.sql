-- Sprint 2-3: Consolidation of the duplicate 026 migration number.
--
-- HISTORICAL NOTE:
--   Two migration files share the prefix 026:
--     - 026_incoming_idempotency.sql
--     - 026_incoming_items_selling_price.sql
--   Both are already recorded in _migrations on every known environment,
--   so renaming either file would skew the ordering for environments
--   where they have run. We leave the files in place and use this
--   "consolidating" migration as a marker + idempotent re-application of
--   the two schema changes, so fresh databases still converge to the same
--   state even if a future operator accidentally drops one of the 026
--   files.

-- Columns added by 026_incoming_idempotency.sql
ALTER TABLE incoming_goods
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS idempotency_request_hash CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS incoming_goods_idempotency_key_key
  ON incoming_goods (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Column added by 026_incoming_items_selling_price.sql
ALTER TABLE incoming_items
  ADD COLUMN IF NOT EXISTS selling_price NUMERIC(10,2);

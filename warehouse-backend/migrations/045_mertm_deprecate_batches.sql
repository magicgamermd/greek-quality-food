-- 045_mertm_deprecate_batches.sql
-- MERT-M does not sell perishable goods, so batches and expiry tracking
-- are no longer used by application code. This migration marks the schema
-- as deprecated but does NOT drop anything (for rollback safety).
-- A future migration (v1.1, after ~2-4 weeks stable operation) will drop
-- the table and columns.

COMMENT ON TABLE batches IS
  'DEPRECATED 2026-04-20 — MERT-M does not use batch/expiry tracking. No code writes to this table. Scheduled for DROP in v1.1.';

COMMENT ON COLUMN batches.batch_number IS
  'DEPRECATED 2026-04-20 — MERT-M does not use batch numbers. Scheduled for DROP in v1.1.';

COMMENT ON COLUMN batches.expiry_date IS
  'DEPRECATED 2026-04-20 — MERT-M sells durable goods; expiry dates are not tracked. Scheduled for DROP in v1.1.';

COMMENT ON COLUMN batches.quantity IS
  'DEPRECATED 2026-04-20 — batch quantity tracking is unused for MERT-M. Scheduled for DROP in v1.1.';

COMMENT ON COLUMN inventory.batch_id IS
  'DEPRECATED 2026-04-20 — MERT-M inventory is not split by batch. Will be NULL for all new rows. Column scheduled for DROP in v1.1.';

COMMENT ON COLUMN incoming_items.batch_id IS
  'DEPRECATED 2026-04-20 — incoming goods are not assigned to batches in MERT-M. Will be NULL for all new rows. Column scheduled for DROP in v1.1.';

COMMENT ON COLUMN order_items.batch_id IS
  'DEPRECATED 2026-04-20 — order items are not linked to batches in MERT-M. Will be NULL for all new rows. Column scheduled for DROP in v1.1.';

COMMENT ON COLUMN order_items.cost_source_batch_id IS
  'DEPRECATED 2026-04-20 — FEFO cost allocation by batch is unused for durable goods. Will be NULL for all new rows. Column scheduled for DROP in v1.1.';

COMMENT ON COLUMN stock_writeoffs.batch_id IS
  'DEPRECATED 2026-04-20 — write-offs are not linked to batches in MERT-M. Will be NULL for all new rows. Column scheduled for DROP in v1.1.';

-- Add partial unique index so inventory has a unique constraint after we stop using batch_id.
-- Required because PostgreSQL treats multiple NULL batch_ids as distinct by default,
-- which would allow duplicate (product_id, warehouse_id, NULL) rows once we write batch_id = NULL.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_product_warehouse_nobatch_uidx
  ON inventory (product_id, warehouse_id)
  WHERE batch_id IS NULL;

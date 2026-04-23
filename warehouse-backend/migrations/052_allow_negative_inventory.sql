-- 052_allow_negative_inventory.sql
-- Allow inventory.quantity to go negative so operators can sell
-- back-ordered stock. Deliveries offset the negative balance via the
-- existing ON CONFLICT upsert in incoming/confirm.
--
-- Rollback (manual, not automated): run
--   ALTER TABLE inventory ADD CONSTRAINT chk_inventory_qty_nonneg
--     CHECK (quantity >= 0);
-- which will fail if any negative rows exist at the time of rollback.

ALTER TABLE inventory DROP CONSTRAINT IF EXISTS chk_inventory_qty_nonneg;

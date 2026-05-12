-- 080_restore_batch_tracking_for_gqf.sql
-- Greek Quality Food: undeprecates the batch / writeoff schema that
-- migration 045_mertm_deprecate_batches.sql marked as DEPRECATED for
-- MERT-M (durable goods, no batches).
--
-- GQF продава хранителни стоки — нетрайни, изискват lot/batch tracking,
-- expiry dates и брак (write-offs). Връщаме функционалността чрез нова
-- миграция (не променяме историческите 011/041/045 — те остават
-- идентични с Greek Foods / MERT-M предците).

COMMENT ON TABLE batches IS
  'ACTIVE — Greek Quality Food ползва batch tracking за нетрайни хранителни стоки.';

COMMENT ON COLUMN batches.batch_number IS NULL;
COMMENT ON COLUMN batches.expiry_date IS NULL;
COMMENT ON COLUMN batches.quantity IS NULL;

COMMENT ON COLUMN inventory.batch_id IS NULL;
COMMENT ON COLUMN incoming_items.batch_id IS NULL;
COMMENT ON COLUMN order_items.batch_id IS NULL;
COMMENT ON COLUMN order_items.cost_source_batch_id IS NULL;
COMMENT ON COLUMN stock_writeoffs.batch_id IS NULL;

-- Drop the "no-batch" partial unique index that MERT-M added in 045.
-- За GQF inventory е batch-aware, така че очакваме (product_id,
-- warehouse_id, batch_id) да е уникалния тройник, не (product_id,
-- warehouse_id) където batch_id IS NULL.
--
-- Старата uniqueness миграция (030_uniqueness_constraints.sql) вече
-- е създала пълния тройник, така че може спокойно да премахнем
-- партилния индекс — той беше въведен само за MERT-M batch-free мод.
DROP INDEX IF EXISTS inventory_product_warehouse_nobatch_uidx;

-- Migration 038: COGS (Cost of Goods Sold) tracking on order_items
--
-- Adds cost_unit_price + cost_source_batch_id to order_items so we can
-- compute real per-sale profit: revenue - cost = profit.
--
-- Populated at order-fulfill time via the FEFO allocator (see
-- services/fefo-allocator.ts): the allocator picks the oldest-expiry batch
-- and records its purchase_price as the sold item's cost.
--
-- Historical orders (pre-migration) are back-filled with products.purchase_price
-- as a best-effort estimate.

BEGIN;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS cost_unit_price NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS cost_source_batch_id INTEGER
    REFERENCES batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_cost_batch
  ON order_items(cost_source_batch_id)
  WHERE cost_source_batch_id IS NOT NULL;

-- Back-fill historical records from products.purchase_price (fallback only;
-- new orders will have accurate batch-specific cost after fulfill).
UPDATE order_items oi
SET cost_unit_price = COALESCE(p.purchase_price, 0)
FROM products p
WHERE oi.product_id = p.id
  AND oi.cost_unit_price IS NULL;

-- Document the new columns
COMMENT ON COLUMN order_items.cost_unit_price IS
  'Purchase cost per unit at time of fulfillment — populated via FEFO allocator. Used for profit = revenue - cost.';
COMMENT ON COLUMN order_items.cost_source_batch_id IS
  'Batch that was allocated for this sale (FEFO). Links back to the incoming delivery that sourced this unit.';

COMMIT;

-- Verification:
-- SELECT COUNT(*) AS rows_without_cost FROM order_items WHERE cost_unit_price IS NULL;
-- -- expect 0 (or only rows where product was deleted/unknown)

-- MERT-M product weight (kg) — required by Econt shipment weight calculation.
-- Ekont v0.2.0 derives total shipment weight from SUM(order_items.quantity * products.weight_kg)
-- so we need per-product weight tracking. COALESCE to 0 at query time handles legacy rows.

ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(10,3);

COMMENT ON COLUMN products.weight_kg IS
  'Product weight in kilograms. Used by /econt/update-shipment to compute total shipment weight. NULL = unknown (treated as 0).';

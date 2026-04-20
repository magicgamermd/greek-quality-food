-- Migration 044: Per-line discount (отстъпка) for order_items
--
-- Adds `discount_percent` (0–100) to order_items so each line in an order
-- can carry an ad-hoc discount. `total_price` is computed at insert time
-- as `qty × unit_price × (1 − discount_percent / 100)` and stored, so all
-- existing sum-based queries (SUM(total_price) for invoice totals, COGS
-- reducers, etc.) keep working without further changes.
--
-- Additive, backward-compatible:
--   * existing rows get discount_percent = 0
--   * total_price for legacy rows stays unchanged (× 1.0)
--   * no constraint on total_price vs discount — trusts the INSERT path
--     (tested via the new zod schema + tests)

BEGIN;

ALTER TABLE order_items
  ADD COLUMN discount_percent numeric(5, 2) NOT NULL DEFAULT 0;

ALTER TABLE order_items
  ADD CONSTRAINT chk_order_items_discount_range
    CHECK (discount_percent >= 0 AND discount_percent <= 100);

COMMIT;

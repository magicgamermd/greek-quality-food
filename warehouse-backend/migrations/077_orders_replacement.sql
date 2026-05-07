-- 077_orders_replacement.sql
-- Adds the "Замяна" (product exchange) feature.
-- See docs/superpowers/specs/2026-05-07-product-replacement-design.md

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_replacement BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_orders_replacement
  ON orders(is_replacement)
  WHERE is_replacement = true;

COMMENT ON COLUMN orders.is_replacement IS
  'Marks an order as a product-exchange order. Such orders contain both given (is_returning=false) and returned (is_returning=true) line items; their total is the signed difference.';

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS is_returning BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN order_items.is_returning IS
  'When true, this line is a returning item in a replacement order — quantity goes back to stock and amount is subtracted from the order total. Only allowed on orders with is_replacement=true (enforced by backend validation).';

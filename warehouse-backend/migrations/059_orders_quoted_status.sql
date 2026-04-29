-- 059_orders_quoted_status.sql
-- Adds 'quoted' to the orders.status CHECK constraint so the cashier
-- can print an offer (OF-XXX) without deducting stock and wait for
-- the customer to confirm.

BEGIN;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'pending', 'confirmed', 'processing', 'fulfilled',
    'invoiced', 'cancelled', 'quoted'
  ));

COMMIT;

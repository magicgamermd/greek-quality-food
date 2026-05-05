-- 072_orders_awaiting_child.sql
-- Child-order architecture for "На изчакване" items.
--
-- When a customer orders products that aren't in stock right now, the
-- shop creates the order as usual but moves the awaiting items into a
-- SEPARATE child order linked to the original via parent_order_id.
-- The main order proceeds normally (invoice, payment, fulfilment); the
-- child waits in a dedicated "На изчакване" view until stock arrives.
--
-- On arrival the cashier marks the child as arrived → its status flips
-- back to 'confirmed' and order_date updates to TODAY, so it shows up
-- in the day's orders for the second customer visit (new invoice, new
-- payment). The original parent_order_id stays for audit / linking.
--
-- Schema:
--   orders.parent_order_id  → FK to orders(id), set on awaiting children
--   orders.status enum     → adds 'awaiting_stock' for child orders that
--                             haven't arrived yet
--
-- Migration is additive — existing rows untouched, all enum values still
-- valid.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS parent_order_id INTEGER REFERENCES orders(id);

CREATE INDEX IF NOT EXISTS idx_orders_parent_order_id
  ON orders(parent_order_id)
  WHERE parent_order_id IS NOT NULL;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'pending', 'confirmed', 'processing', 'fulfilled',
    'invoiced', 'cancelled', 'quoted', 'awaiting_stock'
  ));

COMMIT;

-- 056_orders_below_cost_audit.sql
-- Adds audit columns to orders for the below-cost approval feature.
-- Set when an admin approves selling at least one line below products.purchase_price.
-- Customer-facing PDFs do NOT show these fields — internal audit only.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS below_cost_approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS below_cost_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS below_cost_details JSONB;

CREATE INDEX IF NOT EXISTS idx_orders_below_cost_approved_at
  ON orders(below_cost_approved_at)
  WHERE below_cost_approved_at IS NOT NULL;

COMMIT;

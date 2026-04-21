-- 049_payments_order_id.sql
-- Enables order-only payments (stokova razpiska) alongside invoice-backed ones.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS order_id INT NULL REFERENCES orders(id);

ALTER TABLE payments
  ALTER COLUMN invoice_id DROP NOT NULL;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_invoice_or_order_chk;

ALTER TABLE payments
  ADD CONSTRAINT payments_invoice_or_order_chk
  CHECK (invoice_id IS NOT NULL OR order_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);

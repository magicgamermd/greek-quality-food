ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS annulled_invoice_id INTEGER;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS annulled_invoice_number VARCHAR(120);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS annulled_invoice_at TIMESTAMPTZ;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS annulled_invoice_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_annulled_invoice_at
  ON orders(annulled_invoice_at);

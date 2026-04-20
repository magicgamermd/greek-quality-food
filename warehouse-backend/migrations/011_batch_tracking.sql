-- ============================================================
-- 011 — Enhanced batch tracking: purchase_price, delivery link,
--       received_date, notes, updated_at
-- ============================================================

ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS purchase_price DECIMAL(12,4),
  ADD COLUMN IF NOT EXISTS delivery_id INTEGER REFERENCES incoming_goods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS received_date DATE DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_batches_delivery ON batches(delivery_id);

-- View: total batch quantity per product (useful for listings)
CREATE OR REPLACE VIEW product_batch_summary AS
SELECT
  p.id AS product_id,
  p.name_bg,
  p.name_en,
  p.sku,
  p.unit,
  COALESCE(SUM(b.quantity), 0)::numeric AS total_batch_quantity,
  COUNT(b.id)::int AS batch_count,
  MIN(b.expiry_date) AS earliest_expiry
FROM products p
LEFT JOIN batches b ON b.product_id = p.id AND b.quantity > 0
GROUP BY p.id;

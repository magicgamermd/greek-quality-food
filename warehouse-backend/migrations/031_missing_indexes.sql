-- Sprint 2-3: Missing indexes for common query paths + trigram indexes
-- for ILIKE search performance.

CREATE INDEX IF NOT EXISTS idx_invoices_related
  ON invoices(related_invoice_id)
  WHERE related_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_invoice
  ON orders(invoice_id)
  WHERE invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incoming_items_product
  ON incoming_items(product_id);

CREATE INDEX IF NOT EXISTS idx_incoming_items_batch
  ON incoming_items(batch_id)
  WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_product
  ON order_items(product_id);

CREATE INDEX IF NOT EXISTS idx_order_items_batch
  ON order_items(batch_id)
  WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_batch
  ON inventory(batch_id)
  WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_created
  ON notifications(created_at DESC);

-- pg_trgm for ILIKE searches
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_invoices_number_trgm
  ON invoices USING gin (invoice_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_partners_name_trgm
  ON partners USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_name_bg_trgm
  ON products USING gin (name_bg gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_sku_trgm
  ON products USING gin (sku gin_trgm_ops);

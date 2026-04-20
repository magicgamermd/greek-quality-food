-- Sprint 2-3: Soft-delete columns on products.
-- products.deleted_at / deleted_by allow hiding products from normal queries
-- without breaking historical orders/invoices that reference them.

ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_products_not_deleted
  ON products(id)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE VIEW active_products AS
  SELECT * FROM products WHERE deleted_at IS NULL;

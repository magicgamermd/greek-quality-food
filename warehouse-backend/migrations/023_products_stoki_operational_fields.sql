-- 023: Preserve additional operational fields from STOKI.xlsx imports
ALTER TABLE products ADD COLUMN IF NOT EXISTS print_name VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS vat_group VARCHAR(100);
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_frequently_used BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active);

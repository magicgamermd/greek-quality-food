-- Add brand and pricing fields to products
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand VARCHAR(255),
  ADD COLUMN IF NOT EXISTS purchase_price DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS selling_price DECIMAL(10,2);

-- Index for brand filtering
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);

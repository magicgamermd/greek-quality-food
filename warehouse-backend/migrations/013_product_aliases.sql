-- Migration 013: Product aliases for OCR matching
-- Maps OCR-extracted product names (Greek, English, etc.) to existing DB products

CREATE TABLE product_aliases (
  id SERIAL PRIMARY KEY,
  alias_name VARCHAR(500) NOT NULL,
  alias_name_normalized VARCHAR(500),
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  confidence DECIMAL(3,2) DEFAULT 1.00,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(alias_name_normalized, supplier_id)
);

CREATE INDEX idx_product_aliases_normalized ON product_aliases(alias_name_normalized);
CREATE INDEX idx_product_aliases_product ON product_aliases(product_id);
CREATE INDEX idx_product_aliases_supplier ON product_aliases(supplier_id);

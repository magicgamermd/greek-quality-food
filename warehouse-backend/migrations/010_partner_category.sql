-- 010: Add category to partners (Магазин, Ресторант, etc.)
ALTER TABLE partners ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_partners_category ON partners(category);

-- 009: Add city and microinvest_code to suppliers
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS city VARCHAR(255);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS microinvest_code VARCHAR(50);

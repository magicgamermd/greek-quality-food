-- Add Econt delivery fields to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_city VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_office VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_tracking VARCHAR(100);

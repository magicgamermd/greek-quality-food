-- Migration 006: Add partner_type column to partners table
-- Distinguishes suppliers (Доставчици) from customers

ALTER TABLE partners
ADD COLUMN IF NOT EXISTS partner_type VARCHAR(20) DEFAULT 'customer';

-- Set existing partners that match supplier patterns
-- (will be properly set during future imports based on Група field)

CREATE INDEX IF NOT EXISTS idx_partners_partner_type ON partners(partner_type);

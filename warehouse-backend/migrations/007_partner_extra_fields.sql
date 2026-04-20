-- Migration 007: Add extra Microinvest fields to partners and suppliers tables
-- Fields from Microinvest Warehouse partner export

-- ============================================================
-- EXTEND PARTNERS TABLE
-- ============================================================
ALTER TABLE partners ADD COLUMN IF NOT EXISTS print_name VARCHAR(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS fax VARCHAR(50);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS bic VARCHAR(20);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS iban VARCHAR(50);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS vat_account VARCHAR(50);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS group_name VARCHAR(100);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS client_type VARCHAR(50);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS price_group VARCHAR(50);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(5,2) DEFAULT 0;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS card_number VARCHAR(50);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS payment_days INTEGER DEFAULT 0;

-- ============================================================
-- EXTEND SUPPLIERS TABLE (mirror the same fields)
-- ============================================================
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS print_name VARCHAR(255);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS fax VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bic VARCHAR(20);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS iban VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS vat_account VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS group_name VARCHAR(100);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS client_type VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS price_group VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(5,2) DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS card_number VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_days INTEGER DEFAULT 0;

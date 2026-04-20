-- Add bank_name, bic, mol columns to settings table for invoice generation
ALTER TABLE settings ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS bic TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS mol TEXT;

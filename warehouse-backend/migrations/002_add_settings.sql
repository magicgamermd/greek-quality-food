-- Add Settings Table for Company Configuration
-- This table stores global company settings like name, address, EIK, VAT number, etc.

CREATE TABLE IF NOT EXISTS settings (
    id              INTEGER PRIMARY KEY,
    company_name    TEXT,
    address         TEXT,
    eik             TEXT,
    vat_number      TEXT,
    iban            TEXT,
    phone           TEXT,
    email           TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default empty settings row
INSERT INTO settings (id, company_name, address, eik, vat_number, iban, phone, email, updated_at)
VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NOW())
ON CONFLICT (id) DO NOTHING;

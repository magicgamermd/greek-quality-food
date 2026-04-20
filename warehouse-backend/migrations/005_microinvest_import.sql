-- Migration 005: Microinvest Import Support
-- Extends partners and products tables with Microinvest fields,
-- creates import_logs table for tracking imports.

-- ============================================================
-- EXTEND PARTNERS TABLE
-- (eik, vat_number, address already exist from 001_initial.sql)
-- ============================================================
ALTER TABLE partners ADD COLUMN IF NOT EXISTS microinvest_code VARCHAR(50);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS city VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_partners_microinvest_code ON partners(microinvest_code);

-- ============================================================
-- EXTEND PRODUCTS TABLE
-- ============================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS microinvest_code VARCHAR(50);
ALTER TABLE products ADD COLUMN IF NOT EXISTS group_name VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_products_microinvest_code ON products(microinvest_code);

-- ============================================================
-- IMPORT LOGS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS import_logs (
    id              SERIAL PRIMARY KEY,
    import_type     VARCHAR(20) NOT NULL CHECK (import_type IN ('partners', 'products')),
    file_name       VARCHAR(255) NOT NULL,
    total_rows      INTEGER NOT NULL DEFAULT 0,
    inserted        INTEGER NOT NULL DEFAULT 0,
    updated         INTEGER NOT NULL DEFAULT 0,
    skipped         INTEGER NOT NULL DEFAULT 0,
    errors          INTEGER NOT NULL DEFAULT 0,
    error_details   JSONB DEFAULT '[]'::jsonb,
    imported_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_logs_type ON import_logs(import_type);
CREATE INDEX IF NOT EXISTS idx_import_logs_created ON import_logs(created_at DESC);

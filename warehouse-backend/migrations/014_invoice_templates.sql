-- Migration 014: Invoice templates for few-shot learning
-- Used by AI service to store confirmed invoice extractions per supplier

CREATE TABLE IF NOT EXISTS invoice_templates (
    id SERIAL PRIMARY KEY,
    supplier_name TEXT NOT NULL,
    supplier_eik TEXT,
    image_base64 TEXT NOT NULL,
    extracted_json JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    confirmed BOOLEAN DEFAULT false
);

CREATE INDEX idx_invoice_templates_supplier ON invoice_templates (LOWER(supplier_name));
CREATE INDEX idx_invoice_templates_confirmed ON invoice_templates (confirmed) WHERE confirmed = true;

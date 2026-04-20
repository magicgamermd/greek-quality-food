-- Sprint 1: include_vat toggle + credit notes support

-- 1. Add include_vat column to invoices
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS include_vat BOOLEAN NOT NULL DEFAULT true;

-- 2. Add document_type to invoices (invoice vs credit_note)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'invoice';

-- Add CHECK constraint for document_type
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_document_type_check'
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_document_type_check
      CHECK (document_type IN ('invoice', 'credit_note'));
  END IF;
END$$;

-- 3. Add related_invoice_id for credit notes referencing original invoices
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS related_invoice_id INTEGER REFERENCES invoices(id);

-- 4. Add credit_note_reason column
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS credit_note_reason TEXT;

-- 5. Document counters table for credit note numbering (КИ-XXXXXXXXXX)
CREATE TABLE IF NOT EXISTS document_counters (
  type TEXT PRIMARY KEY,
  current_val INTEGER NOT NULL DEFAULT 0
);

INSERT INTO document_counters (type, current_val) VALUES ('credit_note', 0)
  ON CONFLICT (type) DO NOTHING;

-- Index for credit note lookups
CREATE INDEX IF NOT EXISTS idx_invoices_document_type ON invoices(document_type);
CREATE INDEX IF NOT EXISTS idx_invoices_related ON invoices(related_invoice_id);

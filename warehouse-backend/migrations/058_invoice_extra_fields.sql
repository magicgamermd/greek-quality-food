-- 058_invoice_extra_fields.sql
-- Persistence for two new printable fields on invoices:
--  - vat_exemption_reason: legal basis for issuing without VAT
--    (printed in "Основание за сделката" section)
--  - invoice_note: free-text note ("по проект X") printed below
--    the items table

BEGIN;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS vat_exemption_reason TEXT,
  ADD COLUMN IF NOT EXISTS invoice_note TEXT;

COMMIT;

-- 050_individual_partner_support.sql
-- Adds support for private individual customers (physical persons without ЕИК).
-- Inserts a reusable anonymous "Физическо лице — краен потребител" partner
-- used when the cashier sells to a walk-in customer without collecting any
-- personal data. Also adds an optional invoice column for cases when the
-- customer asks the invoice to be issued on a specific name.

-- Idempotent: safe to run multiple times.
INSERT INTO partners (name, print_name, partner_type)
SELECT 'Физическо лице — краен потребител',
       'Физическо лице — краен потребител',
       'individual'
WHERE NOT EXISTS (
  SELECT 1 FROM partners
  WHERE name = 'Физическо лице — краен потребител'
    AND partner_type = 'individual'
);

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS client_display_name VARCHAR(255);

COMMENT ON COLUMN invoices.client_display_name IS
  'Optional override for the buyer name printed on the invoice PDF. '
  'Used when partner_type=individual and the customer asks the invoice '
  'to be issued on a specific name (e.g. for warranty purposes). '
  'NULL = fall back to partner.name.';

-- 085_proforma_invoices.sql
-- Adds proforma invoice support:
--   - Extend invoices.document_type enum to allow 'proforma'
--   - Separate document_counters row for proforma (starts at 199 → next call returns 200)
--   - generate_proforma_number() SQL function — atomic 10-digit number from
--     the proforma counter, gap-free per advisory lock
--
-- Proforma is a non-fiscal document — customer agrees on price/items,
-- pays based on it, then we issue the real fiscal invoice. The two
-- live in the same invoices table for unified PDF generation, but they
-- have separate numbering streams so the proforma sequence doesn't pollute
-- the regulated invoice sequence (НАП audit).

BEGIN;

-- 1. Allow document_type='proforma'
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_document_type_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_document_type_check
  CHECK (document_type = ANY (ARRAY[
    'invoice'::text,
    'credit_note'::text,
    'proforma'::text
  ]));

-- 2. Seed proforma counter at 199 so first generate_proforma_number()
--    returns "0000000200" — bizdec wanted to start at 200 (not 1) to
--    leave the lower range for legacy/pre-system documents if any.
INSERT INTO document_counters (type, current_val)
  VALUES ('proforma', 199)
  ON CONFLICT (type) DO NOTHING;

-- 3. Atomic proforma number generator. Mirrors generate_invoice_number()
--    structure (advisory lock + format) but reads from document_counters
--    instead of the global invoices MAX, so the proforma stream stays
--    isolated from the fiscal invoice stream.
CREATE OR REPLACE FUNCTION generate_proforma_number()
RETURNS TEXT AS $$
DECLARE
  next_num BIGINT;
  proforma_num TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('proforma_number_global'));

  UPDATE document_counters
     SET current_val = current_val + 1
   WHERE type = 'proforma'
  RETURNING current_val INTO next_num;

  IF next_num IS NULL THEN
    -- Row missing (shouldn't happen after the INSERT above, but be safe).
    INSERT INTO document_counters (type, current_val) VALUES ('proforma', 200);
    next_num := 200;
  END IF;

  proforma_num := LPAD(next_num::TEXT, 10, '0');
  RETURN proforma_num;
END;
$$ LANGUAGE plpgsql;

-- 4. Allow proforma to skip the related_invoice_id uniqueness constraint
--    (which was scoped to credit_note already, so nothing to change there).
--    Also: proforma → real invoice link uses related_invoice_id, but in
--    the OPPOSITE direction from credit_note. We use proforma_id on the
--    real invoice instead — a separate FK column for clarity.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS proforma_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_proforma_id
  ON invoices (proforma_id) WHERE proforma_id IS NOT NULL;

-- 5. orders.proforma_invoice_id — link от поръчката към активната
--    проформа, за да може /finalize endpoint да намери правилната
--    поръчка вместо да гадае с heuristic. Стандартно orders.invoice_id
--    линква само РЕАЛНА фактура; за проформа е отделно поле, така че
--    "поръчка без фактура" остава true до финализиране.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS proforma_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_proforma_invoice_id
  ON orders (proforma_invoice_id) WHERE proforma_invoice_id IS NOT NULL;

-- 6. Update generate_invoice_number() to EXCLUDE proforma rows. Преди
--    проформа документи (0000000200+) се появяваха в фискалната редица
--    и MAX(invoice_number) минаваше през тях → следващата реална
--    фактура получаваше номер 201 вместо очаквания следващ от
--    фискалната редица (напр. 28). Сега filter-ваме document_type!='proforma'.
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TEXT AS $$
DECLARE
  next_num BIGINT;
  invoice_num TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number_global'));
  SELECT COALESCE(
           MAX(CAST(invoice_number AS BIGINT)),
           1
         ) + 1
    INTO next_num
    FROM invoices
   WHERE invoice_number ~ '^\d{10}$'
     AND document_type <> 'proforma';
  invoice_num := LPAD(next_num::TEXT, 10, '0');
  RETURN invoice_num;
END;
$$ LANGUAGE plpgsql;

COMMIT;

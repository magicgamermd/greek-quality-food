-- Sprint 2-3: Gap-free invoice numbering.
-- Uses a transactional advisory lock keyed by year so concurrent callers
-- serialise while still being isolated per fiscal year. A reservation
-- table is added so callers can reserve a number ahead of actually writing
-- the invoice row (two-phase allocation).

CREATE TABLE IF NOT EXISTS invoice_number_reservations (
  invoice_id     INT REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL UNIQUE,
  reserved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  committed      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_invoice_num_reservations_committed
  ON invoice_number_reservations(committed, invoice_number);

-- Drop legacy no-arg overload if present. The new implementation uses a
-- single signature with a default argument; keeping the no-arg overload
-- makes unqualified calls ambiguous.
DROP FUNCTION IF EXISTS generate_invoice_number();

-- Transactional version: serialises number generation per year via
-- pg_advisory_xact_lock so parallel transactions cannot both pick the
-- same next number. Must be called inside a transaction.
CREATE OR REPLACE FUNCTION generate_invoice_number(invoice_year INT DEFAULT NULL)
RETURNS TEXT AS $$
DECLARE
  year_val    INT;
  next_num    INT;
  invoice_num TEXT;
BEGIN
  year_val := COALESCE(invoice_year, EXTRACT(YEAR FROM CURRENT_DATE)::INT);

  -- Advisory lock per year to serialise generators.
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number_' || year_val));

  SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 'GF-\d{4}-(\d+)$') AS INT)), 0) + 1
    INTO next_num
    FROM invoices
   WHERE invoice_number LIKE 'GF-' || year_val || '-%';

  invoice_num := 'GF-' || year_val || '-' || LPAD(next_num::TEXT, 4, '0');
  RETURN invoice_num;
END;
$$ LANGUAGE plpgsql;

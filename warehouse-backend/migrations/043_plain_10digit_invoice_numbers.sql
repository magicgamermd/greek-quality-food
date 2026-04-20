-- Migration 043: Switch invoice numbering to plain 10-digit НАП format
--
-- Replaces the legacy "GF-YYYY-NNNN" (Greek Foods prefix + year + 4-digit)
-- format with the НАП-standard 10-digit zero-padded sequence number
-- that Bulgarian fiscal regulations expect on commercial invoices:
--
--   OLD: GF-2026-0042
--   NEW: 0000000002
--
-- Key differences vs. migration 033:
--   * No prefix — the sequence is just digits, exactly 10 characters.
--   * Cross-year — the sequence does NOT reset on January 1st (НАП
--     compliant ООД/ЕООД numbering is continuous across years).
--   * Starts at 2 when the invoices table is empty — the assumption is
--     that "0000000001" is reserved for the first invoice that was
--     issued outside the system (hand-written, migrated from legacy
--     accounting, or given to NAP as the first registered number).
--     When existing rows are present the sequence continues from
--     MAX(existing) + 1.
--
-- Credit notes continue to use the separate КИ-NNNNNNNNNN series via
-- `document_counters` — Bulgarian practice treats commercial invoices
-- and credit notes as distinct document streams, each gap-free on its
-- own. No change needed there.

BEGIN;

-- Drop the year-parameterised overload from migration 033 because we
-- no longer need the year argument — the new format is year-agnostic.
DROP FUNCTION IF EXISTS generate_invoice_number(INT);

CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TEXT AS $$
DECLARE
  next_num BIGINT;
  invoice_num TEXT;
BEGIN
  -- Global advisory lock — all invoice-number generators serialise
  -- against each other since there's only one sequence now (no per-year
  -- partitioning).
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number_global'));

  -- MAX of the numeric interpretation of existing invoice numbers.
  -- The regex `^\d{10}$` filters out any legacy rows still in the old
  -- format (GF-2026-NNNN, КИ-NNNNNNNNNN, etc.) so they don't confuse
  -- the MAX calculation. +1 to get the next slot.
  --
  -- When no 10-digit rows exist yet (fresh DB after Variant Y reset),
  -- COALESCE returns 1 so the function emits "0000000002" — honouring
  -- the user's requirement that the first issued invoice be 0000000002
  -- (the assumption being 0000000001 is reserved off-system).
  SELECT COALESCE(
           MAX(CAST(invoice_number AS BIGINT)),
           1
         ) + 1
    INTO next_num
    FROM invoices
   WHERE invoice_number ~ '^\d{10}$';

  invoice_num := LPAD(next_num::TEXT, 10, '0');
  RETURN invoice_num;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- Verification (run manually after applying):
--   SELECT generate_invoice_number();  -- should return "0000000002"
--                                      -- when invoices table is empty

-- Migration 040: Enable fuzzystrmatch for OCR-tolerant invoice duplicate detection
--
-- Use case: the same invoice gets scanned twice — once from the original PDF
-- and once from a phone photo — and the OCR reads the number slightly
-- differently each time (0↔O, 1↔I, J↔I, punctuation jitter). Our existing
-- exact-match dedupe misses these, so we end up with two rows for the same
-- physical invoice.
--
-- Fix: a second-tier check that applies an OCR-collapse transliteration
-- (see `src/utils/invoice-normalization.ts → invoiceOcrKey`) then uses
-- PostgreSQL's `levenshtein()` to accept edits ≤ 2 within the same
-- supplier's recent invoices.
--
-- `fuzzystrmatch` provides `levenshtein()`, `soundex()`, `metaphone()`.
-- Part of contrib; always available on standard PostgreSQL images.

BEGIN;

CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- Sanity check: fail loudly if the extension didn't register
DO $$
BEGIN
  PERFORM levenshtein('abc', 'abd');
EXCEPTION WHEN undefined_function THEN
  RAISE EXCEPTION
    'fuzzystrmatch.levenshtein() not available after CREATE EXTENSION';
END $$;

COMMIT;

-- Verification:
-- SELECT levenshtein('AINEENAOOOI4', 'AINEENOAOOOI4');  -- → 1

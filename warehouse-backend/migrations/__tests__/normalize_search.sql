-- Regression assertions for the normalize_search() PG function
-- and its accompanying trigram + word_similarity thresholds used
-- across supplier / product / partner search.
--
-- How to run:
--   docker exec -i warehouse-backend-postgres-1 \
--     psql -U greekfoods -d greekfoods_warehouse -v ON_ERROR_STOP=1 \
--     < warehouse-backend/migrations/__tests__/normalize_search.sql
--
-- Every assertion uses `DO $$ ... RAISE EXCEPTION ... $$` so any
-- regression fails the whole script with a non-zero exit.
--
-- Covered behaviours:
--   1. Cyrillic → Latin transliteration (migration 037)
--   2. Greek   → Latin transliteration (migration 039)
--   3. Punctuation / accent stripping
--   4. Cross-alphabet similarity thresholds used by suppliers fuzzy match
--   5. OCR-collapsed invoice-number Levenshtein (migration 040)

BEGIN;

-- ── 1. Cyrillic → Latin ─────────────────────────────────────────────────

DO $$
DECLARE
  actual text;
BEGIN
  actual := normalize_search('БАКАЛИЯ');
  IF actual IS DISTINCT FROM 'bakaliya' AND actual IS DISTINCT FROM 'bakalia' THEN
    RAISE EXCEPTION 'cyrillic→latin: expected bakaliya/bakalia, got %', actual;
  END IF;

  actual := normalize_search('София');
  IF actual IS DISTINCT FROM 'sofiya' AND actual IS DISTINCT FROM 'sofia' THEN
    RAISE EXCEPTION 'cyrillic→latin: expected sofiya/sofia, got %', actual;
  END IF;

  actual := normalize_search('ЩЪРК');
  IF actual NOT LIKE 'shta%' THEN
    RAISE EXCEPTION 'cyrillic digraphs: expected "shtark" prefix, got %', actual;
  END IF;
END $$;

-- ── 2. Greek → Latin (Modern Greek phonetic) ─────────────────────────────

DO $$
DECLARE
  actual text;
BEGIN
  actual := normalize_search('ΜΠΑΚΑΒΟΣ');
  IF actual <> 'mpakavos' THEN
    RAISE EXCEPTION 'greek→latin: expected mpakavos, got %', actual;
  END IF;

  actual := normalize_search('ΝΙΚΟΛΑΟΣ');
  IF actual <> 'nikolaos' THEN
    RAISE EXCEPTION 'greek→latin: expected nikolaos, got %', actual;
  END IF;

  actual := normalize_search('ΒΛΑΣΤΗ');
  IF actual <> 'vlasti' THEN
    RAISE EXCEPTION 'greek→latin (β→v, η→i): expected vlasti, got %', actual;
  END IF;

  -- Greek digraph + accented vowels
  actual := normalize_search('Θεσσαλονίκη');
  IF actual NOT LIKE 'thess%' THEN
    RAISE EXCEPTION 'greek digraph θ→th: expected "thess..." prefix, got %', actual;
  END IF;
END $$;

-- ── 3. Punctuation / accents stripping ───────────────────────────────────

DO $$
DECLARE
  actual text;
BEGIN
  -- Multiple punctuation runs collapse to single space
  actual := normalize_search('ELMAR CRETE S.A.');
  IF actual <> 'elmar crete s a ' AND actual <> 'elmar crete s a' THEN
    RAISE EXCEPTION 'punctuation stripping: got "%"', actual;
  END IF;

  -- NULL passes through unchanged
  actual := normalize_search(NULL);
  IF actual IS NOT NULL THEN
    RAISE EXCEPTION 'NULL input must return NULL, got "%"', actual;
  END IF;

  -- Empty string returns empty
  actual := normalize_search('');
  IF actual IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'empty input must return empty string, got "%"', actual;
  END IF;
END $$;

-- ── 4. Similarity thresholds used by supplier fuzzy matcher ──────────────
--
-- The production code in routes/incoming.ts accepts a fuzzy match if:
--   similarity(...)        >= 0.45
--   word_similarity(...)   >= 0.70   (either direction)
-- These assertions lock in the real-world cases that motivated the
-- migration so future edits to normalize_search don't silently break
-- supplier resolution.

DO $$
DECLARE
  sim float;
  wsim_a float;
  wsim_b float;
BEGIN
  -- Case: Greek-scripted short name vs Latin-scripted long name.
  -- ΜΠΑΚΑΒΟΣ ΑΠΟΣΤ. ΝΙΚΟΛΑΟΣ  ↔  VLASTI/MPAKAVOS AP. NIKOLAOS
  -- Real fuzzy threshold is word_similarity >= 0.70.
  wsim_a := word_similarity(
    normalize_search('ΜΠΑΚΑΒΟΣ ΑΠΟΣΤ. ΝΙΚΟΛΑΟΣ'),
    normalize_search('VLASTI/MPAKAVOS AP. NIKOLAOS')
  );
  wsim_b := word_similarity(
    normalize_search('VLASTI/MPAKAVOS AP. NIKOLAOS'),
    normalize_search('ΜΠΑΚΑΒΟΣ ΑΠΟΣΤ. ΝΙΚΟΛΑΟΣ')
  );
  IF GREATEST(wsim_a, wsim_b) < 0.70 THEN
    RAISE EXCEPTION
      'MPAKAVOS greek/latin word_similarity regression: a=% b=%',
      wsim_a, wsim_b;
  END IF;

  -- Case: short Latin name contained in long Latin name.
  -- ELMAR CRETE S.A.  ⊂  ELMAR CRETE S.A COMMERCIAL & INDUSTRIAL CO.
  -- word_similarity (short→long) should reach 1.0.
  wsim_a := word_similarity(
    normalize_search('ELMAR CRETE S.A.'),
    normalize_search('ELMAR CRETE S.A COMMERCIAL & INDUSTRIAL CO.')
  );
  IF wsim_a < 0.95 THEN
    RAISE EXCEPTION
      'ELMAR short⊂long regression: word_similarity = %', wsim_a;
  END IF;

  -- Case: typo-level similarity
  -- CONFECTIONARY vs CONFECTIONERY (A vs E, 1 char edit).
  -- Must stay above 0.45 `similarity` threshold.
  sim := similarity(
    normalize_search('IOANNOU CONFECTIONARY'),
    normalize_search('IOANNOU CONFECTIONERY')
  );
  IF sim < 0.45 THEN
    RAISE EXCEPTION
      'IOANNOU typo regression: similarity = %', sim;
  END IF;
END $$;

-- ── 5. fuzzystrmatch.levenshtein() for OCR invoice dedup ─────────────────

DO $$
DECLARE
  d int;
BEGIN
  -- DAGKOS regression: PDF vs phone-photo scan converge under OCR collapse.
  -- ocrKey('A-JNE-ENA00014')   = 'AINEENAOOOI4'     (12 chars)
  -- ocrKey('A.INE-ENA0000014') = 'AINEENAOOOOOI4'   (14 chars)
  -- Tier-2 accepts edit_distance <= 2.
  d := levenshtein('AINEENAOOOI4', 'AINEENAOOOOOI4');
  IF d > 2 THEN
    RAISE EXCEPTION
      'DAGKOS OCR levenshtein regression: distance = %', d;
  END IF;

  -- Negative control: unrelated invoices must stay well above the threshold.
  d := levenshtein('AINEENAOOOI4', 'KOSTASOOOOOOS');
  IF d <= 2 THEN
    RAISE EXCEPTION
      'Unrelated invoices collide: distance = % (should be >> 2)', d;
  END IF;
END $$;

-- ── 6. Trigram / word_similarity extensions are enabled ──────────────────

DO $$
BEGIN
  PERFORM 1
  FROM pg_extension
  WHERE extname IN ('pg_trgm', 'fuzzystrmatch')
  HAVING COUNT(*) >= 2;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Required extensions missing: pg_trgm or fuzzystrmatch not installed';
  END IF;
END $$;

-- ── 7. Trigram indexes exist on normalized columns ───────────────────────

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT ARRAY_AGG(expected)
    INTO missing
  FROM (
    SELECT UNNEST(ARRAY[
      'idx_partners_name_norm_trgm',
      'idx_suppliers_name_norm_trgm',
      'idx_products_name_bg_norm_trgm',
      'idx_products_name_en_norm_trgm',
      'idx_supplier_aliases_norm_trgm'
    ]) AS expected
  ) expected
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = expected.expected
  );
  IF missing IS NOT NULL AND array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION
      'Missing trigram indexes: %', missing;
  END IF;
END $$;

COMMIT;

-- Final OK signal for CI / manual runs
SELECT 'normalize_search regression suite: all assertions passed' AS result;

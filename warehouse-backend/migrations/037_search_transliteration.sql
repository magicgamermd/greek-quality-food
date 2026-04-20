-- Migration 037: Cyrillic ↔ Latin transliteration-aware search
--
-- Adds an IMMUTABLE SQL function `normalize_search(text)` that folds a string
-- into a searchable key. Both the query and the indexed column values pass
-- through this function so users can type with either alphabet and still
-- get hits.
--
-- Used by: partners / suppliers / products / invoices / orders search endpoints.

BEGIN;

-- Core normalizer: lowercase + Cyrillic→Latin transliteration (official BG scheme)
-- Returns NULL on NULL input. Must be IMMUTABLE for index use.
CREATE OR REPLACE FUNCTION normalize_search(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN input IS NULL THEN NULL ELSE
    regexp_replace(
      -- Drop glide-y between any letter and a vowel (bakaliya → bakalia, sofiya → sofia).
      -- Makes official transliteration match informal Latin typing.
      regexp_replace(
        translate(
          replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
            lower(input),
            'щ', 'sht'),
            'ш', 'sh'),
            'ч', 'ch'),
            'ж', 'zh'),
            'ю', 'yu'),
            'я', 'ya'),
            'ц', 'ts'),
            'ь', 'y'),
            'ъ', 'a'),
            'й', 'y'
          ),
          -- Single-char Cyrillic → Latin (order matters: after multi-char above)
          'абвгдезиклмнопрстуфхеё',
          'abvgdeziklmnoprstufhee'
        ),
        '([a-z])y([aeiou])', '\1\2', 'g'
      ),
      '[^a-z0-9 ]+', ' ', 'g'
    )
  END;
$$;

-- Trigram indexes on normalized columns (small, selective)
CREATE INDEX IF NOT EXISTS idx_partners_name_norm_trgm
  ON partners USING gin (normalize_search(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_suppliers_name_norm_trgm
  ON suppliers USING gin (normalize_search(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_name_bg_norm_trgm
  ON products USING gin (normalize_search(name_bg) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_name_en_norm_trgm
  ON products USING gin (normalize_search(name_en) gin_trgm_ops);

COMMIT;

-- Quick verification:
-- SELECT normalize_search('БАКАЛИЯ');     -- → 'bakaliya'
-- SELECT normalize_search('София');        -- → 'sofiya'
-- SELECT normalize_search('Koukakis S.A'); -- → 'koukakis s a'
-- SELECT * FROM partners
--   WHERE normalize_search(name) ILIKE '%' || normalize_search('bakalia') || '%'
--   LIMIT 5;

-- Migration 039: Supplier aliases (learn from user corrections) + Greek transliteration
--
-- Problem:
--   When an AI-scanned invoice contains a supplier name in Greek script
--   (e.g. "ΜΠΑΚΑΒΟΣ ΑΠΟΣΤ. ΝΙΚΟΛΑΟΣ"), our existing `normalize_search()` strips
--   all Greek codepoints — so trigram fuzzy match against a Latin-scripted
--   name ("VLASTI/MPAKAVOS AP. NIKOLAOS") returns 0 hits and we create a
--   duplicate supplier with empty details. Also, even with translit, some
--   spellings are too different (SARIMPOGIAS vs SARYPOGLAS) for automated
--   matching.
--
-- Solution (two independent mechanisms, both applied on save):
--   A) Extend `normalize_search()` to transliterate Greek → Latin
--      (Modern Greek phonetic scheme). Catches the common case.
--   B) Add a `supplier_aliases` table that remembers every AI-extracted
--      raw name → resolved supplier_id. On subsequent scans with an
--      identical / near-identical raw name, we link directly via the
--      alias (bypassing trigram entirely). This lets users TEACH the
--      system once and never see the same duplication again.

BEGIN;

-- ── (A) Rebuild normalize_search with Greek support ─────────────────────

-- Drop dependent indexes first (IMMUTABLE function change invalidates them)
DROP INDEX IF EXISTS idx_partners_name_norm_trgm;
DROP INDEX IF EXISTS idx_suppliers_name_norm_trgm;
DROP INDEX IF EXISTS idx_products_name_bg_norm_trgm;
DROP INDEX IF EXISTS idx_products_name_en_norm_trgm;

CREATE OR REPLACE FUNCTION normalize_search(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  s text;
BEGIN
  IF input IS NULL THEN
    RETURN NULL;
  END IF;
  s := lower(input);

  -- Cyrillic digraphs
  s := replace(s, 'щ', 'sht');
  s := replace(s, 'ш', 'sh');
  s := replace(s, 'ч', 'ch');
  s := replace(s, 'ж', 'zh');
  s := replace(s, 'ю', 'yu');
  s := replace(s, 'я', 'ya');
  s := replace(s, 'ц', 'ts');
  s := replace(s, 'ь', 'y');

  -- Greek digraphs (Modern Greek phonetic)
  s := replace(s, 'θ', 'th');
  s := replace(s, 'ψ', 'ps');
  s := replace(s, 'ξ', 'x');
  s := replace(s, 'χ', 'h');

  -- Greek accented vowels → folded to unaccented
  s := replace(s, 'ά', 'a');
  s := replace(s, 'έ', 'e');
  s := replace(s, 'ή', 'i');
  s := replace(s, 'ί', 'i');
  s := replace(s, 'ό', 'o');
  s := replace(s, 'ύ', 'y');
  s := replace(s, 'ώ', 'o');
  s := replace(s, 'ϊ', 'i');
  s := replace(s, 'ϋ', 'y');

  -- Single-char translit table: Cyrillic + Greek → Latin
  --
  --   Cyrillic (24 chars):
  --     ъ й а б в г д е з и к л м н о п р с т у ф х е ё
  --     a y a b v g d e z i k l m n o p r s t u f h e e
  --
  --   Greek lowercase (21 chars, Modern Greek phonetic):
  --     α β γ δ ε ζ η ι κ λ μ ν ο π ρ σ τ υ φ ω ς
  --     a v g d e z i i k l m n o p r s t y f o s
  --
  --   (θ ψ ξ χ + accented vowels are handled by the replace() calls above.)
  s := translate(
    s,
    'ъйабвгдезиклмнопрстуфхеё' ||
      'αβγδεζηικλμνοπρστυφως',
    'ayabvgdeziklmnoprstufhee' ||
      'avgdeziiklmnoprstyfos'
  );

  -- Drop glide-y between a letter and a vowel (bakaliya → bakalia)
  s := regexp_replace(s, '([a-z])y([aeiou])', '\1\2', 'g');

  -- Strip everything non-alphanumeric (keeps words spaced out)
  s := regexp_replace(s, '[^a-z0-9 ]+', ' ', 'g');

  RETURN s;
END;
$$;

-- Rebuild trigram indexes on the new normalizer
CREATE INDEX IF NOT EXISTS idx_partners_name_norm_trgm
  ON partners USING gin (normalize_search(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_suppliers_name_norm_trgm
  ON suppliers USING gin (normalize_search(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_name_bg_norm_trgm
  ON products USING gin (normalize_search(name_bg) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_name_en_norm_trgm
  ON products USING gin (normalize_search(name_en) gin_trgm_ops);

-- ── (B) supplier_aliases table ──────────────────────────────────────────
--
-- alias_raw: exactly the string the AI extracted / the user typed — kept
--   for audit and for displaying "last seen as …".
-- alias_normalized: normalize_search(alias_raw) — what we match against.
-- supplier_id: the canonical supplier this alias resolves to.
-- source: 'auto' when backend resolved via EIK/VAT/name match,
--         'user_confirmed' when a human picked it from the suggestion UI.
-- confidence: 1.0 for user_confirmed, similarity score for auto.
-- hit_count: incremented every time this alias is matched (lets us
--   surface the most-used aliases in admin UIs and retire stale ones).

CREATE TABLE IF NOT EXISTS supplier_aliases (
  id                SERIAL PRIMARY KEY,
  alias_raw         TEXT        NOT NULL,
  alias_normalized  TEXT        NOT NULL,
  supplier_id       INT         NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  source            VARCHAR(32) NOT NULL DEFAULT 'auto',
  confidence        NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  hit_count         INT         NOT NULL DEFAULT 1,
  created_by        UUID        NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One normalized alias maps to exactly one supplier (no ambiguity)
  CONSTRAINT uq_supplier_aliases_norm UNIQUE (alias_normalized)
);

CREATE INDEX IF NOT EXISTS idx_supplier_aliases_supplier
  ON supplier_aliases (supplier_id);

CREATE INDEX IF NOT EXISTS idx_supplier_aliases_norm_trgm
  ON supplier_aliases USING gin (alias_normalized gin_trgm_ops);

-- Backfill: every existing supplier's own `name` becomes an implicit alias
-- (so scans that re-extract the canonical name match by exact alias).
INSERT INTO supplier_aliases (alias_raw, alias_normalized, supplier_id, source, confidence)
SELECT name, normalize_search(name), id, 'backfill', 1.000
FROM suppliers
WHERE name IS NOT NULL AND TRIM(name) <> ''
ON CONFLICT (alias_normalized) DO NOTHING;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────
-- SELECT normalize_search('ΜΠΑΚΑΒΟΣ ΑΠΟΣΤ. ΝΙΚΟΛΑΟΣ');
--   → 'mpakavos apost  nikolaos'   (was: 'm')
-- SELECT normalize_search('VLASTI/MPAKAVOS AP. NIKOLAOS');
--   → 'vlasti mpakavos ap  nikolaos'
-- SELECT similarity(
--   normalize_search('ΜΠΑΚΑΒΟΣ ΑΠΟΣΤ. ΝΙΚΟΛΑΟΣ'),
--   normalize_search('VLASTI/MPAKAVOS AP. NIKOLAOS'));
--   → ≈ 0.5+
-- SELECT COUNT(*) FROM supplier_aliases;   -- should equal unique supplier names

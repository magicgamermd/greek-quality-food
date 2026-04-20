-- 022 — Normalize legacy product aliases and enforce case-insensitive uniqueness

-- Canonicalize stored normalized key for existing rows.
-- Keep this SQL normalization conservative and deterministic:
-- - lower case
-- - punctuation to spaces
-- - collapse repeated whitespace
-- Runtime matcher still does richer Unicode normalization in app code.
UPDATE product_aliases
SET alias_name_normalized = LOWER(
  REGEXP_REPLACE(
    REGEXP_REPLACE(TRIM(COALESCE(alias_name, '')), '[[:punct:]]+', ' ', 'g'),
    '\s+',
    ' ',
    'g'
  )
)
WHERE alias_name IS NOT NULL;

-- Remove duplicates that would violate CI uniqueness.
-- Keep the most recently updated (fallback to latest id).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(COALESCE(alias_name_normalized, '')), COALESCE(supplier_id, -1)
      ORDER BY updated_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM product_aliases
)
DELETE FROM product_aliases pa
USING ranked r
WHERE pa.id = r.id
  AND r.rn > 1;

-- Drop old case-sensitive unique constraint if present.
ALTER TABLE product_aliases
  DROP CONSTRAINT IF EXISTS product_aliases_alias_name_normalized_supplier_id_key;

-- Enforce case-insensitive uniqueness by normalized alias + supplier (null supplier treated as global).
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_aliases_norm_supplier_ci
  ON product_aliases (LOWER(alias_name_normalized), COALESCE(supplier_id, -1));


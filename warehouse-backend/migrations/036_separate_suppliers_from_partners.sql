-- Migration 036: Separate Greek suppliers from partners table
--
-- Context: Historical data import merged Greek suppliers (vendors) into the
-- partners table (BG customers). This migration:
--   1. Creates a backup table (partners_greek_backup) before any DELETE
--   2. Removes Greek-named partners that are already duplicated in suppliers
--      and have NO foreign-key references (no orders/invoices/partner_order_objects)
--   3. Flags remaining Greek-named partners that have references — user
--      reviews manually (see review view at bottom)
--
-- This migration is SAFE: it only deletes rows that are duplicates and unused.
-- A rollback is possible by re-inserting from partners_greek_backup.

BEGIN;

-- 1. Snapshot affected rows into backup table (idempotent: IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS partners_greek_backup AS
SELECT * FROM partners WHERE FALSE;

INSERT INTO partners_greek_backup
SELECT p.*
FROM partners p
WHERE p.name !~ '[а-яА-Я]'   -- no Cyrillic letters in name
  AND (p.city IS NULL OR p.city !~ '[а-яА-Я]')  -- no Cyrillic in city
  -- Exclude BG / intl companies with Latin names
  AND (p.city IS NULL OR (
        UPPER(p.city) NOT LIKE '%SOFIA%'
    AND UPPER(p.city) NOT LIKE '%PERNIK%'
    AND UPPER(p.city) NOT LIKE '%LEYTON%'
    AND UPPER(p.city) NOT LIKE '%LARNACA%'
    AND UPPER(p.city) NOT LIKE '%CYPRUS%'
  ))
  -- Only back up rows that will be deleted (have dup in suppliers AND no refs)
  AND EXISTS (
    SELECT 1 FROM suppliers s
    WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(p.name))
  )
  AND NOT EXISTS (SELECT 1 FROM orders WHERE partner_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM invoices WHERE partner_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM partner_order_objects WHERE partner_id = p.id)
ON CONFLICT DO NOTHING;

-- 2. Delete the safe duplicates from partners
WITH to_delete AS (
  SELECT p.id
  FROM partners p
  WHERE p.name !~ '[а-яА-Я]'
    AND (p.city IS NULL OR p.city !~ '[а-яА-Я]')
    AND (p.city IS NULL OR (
          UPPER(p.city) NOT LIKE '%SOFIA%'
      AND UPPER(p.city) NOT LIKE '%PERNIK%'
      AND UPPER(p.city) NOT LIKE '%LEYTON%'
      AND UPPER(p.city) NOT LIKE '%LARNACA%'
      AND UPPER(p.city) NOT LIKE '%CYPRUS%'
    ))
    AND EXISTS (
      SELECT 1 FROM suppliers s
      WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(p.name))
    )
    AND NOT EXISTS (SELECT 1 FROM orders WHERE partner_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM invoices WHERE partner_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM partner_order_objects WHERE partner_id = p.id)
)
DELETE FROM partners WHERE id IN (SELECT id FROM to_delete);

-- 3. Create a view listing Greek-named partners that could NOT be auto-cleaned
--    (because they have orders/invoices referencing them). The user should
--    review each one and decide whether to merge, reassign, or keep.
CREATE OR REPLACE VIEW v_greek_partners_to_review AS
SELECT
  p.id,
  p.name,
  p.city,
  p.address,
  (SELECT COUNT(*) FROM orders o WHERE o.partner_id = p.id) AS orders_count,
  (SELECT COUNT(*) FROM invoices i WHERE i.partner_id = p.id) AS invoices_count,
  (SELECT COUNT(*) FROM partner_order_objects po WHERE po.partner_id = p.id) AS poo_count,
  EXISTS (
    SELECT 1 FROM suppliers s
    WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(p.name))
  ) AS also_in_suppliers
FROM partners p
WHERE p.name !~ '[а-яА-Я]'
  AND (p.city IS NULL OR p.city !~ '[а-яА-Я]')
  AND (p.city IS NULL OR (
        UPPER(p.city) NOT LIKE '%SOFIA%'
    AND UPPER(p.city) NOT LIKE '%PERNIK%'
    AND UPPER(p.city) NOT LIKE '%LEYTON%'
    AND UPPER(p.city) NOT LIKE '%LARNACA%'
    AND UPPER(p.city) NOT LIKE '%CYPRUS%'
  ));

COMMIT;

-- Post-migration verification queries (run manually):
-- SELECT COUNT(*) FROM partners_greek_backup;
-- SELECT * FROM v_greek_partners_to_review;
-- SELECT COUNT(*) FROM partners;
-- SELECT COUNT(*) FROM suppliers;

-- 057_order_items_product_name_snapshot.sql
-- Snapshots product identity (name_bg, name_en, sku) onto each order_items
-- row at INSERT time, so historical documents preserve the name that was
-- in use at issuance even after the product is renamed in the catalog.

BEGIN;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS name_bg_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS name_en_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS sku_snapshot TEXT;

-- Backfill existing rows from the current catalog. Acceptable inaccuracy:
-- legacy rows for products that have already been renamed will receive
-- the *current* name, not the one that was on the document at issuance —
-- but that data is unrecoverable. Going forward, snapshots are exact.
UPDATE order_items oi
   SET name_bg_snapshot = p.name_bg,
       name_en_snapshot = p.name_en,
       sku_snapshot     = p.sku
  FROM products p
 WHERE oi.product_id = p.id
   AND oi.name_bg_snapshot IS NULL;

-- products.name_bg is NOT NULL, so every existing row is now non-null.
ALTER TABLE order_items
  ALTER COLUMN name_bg_snapshot SET NOT NULL;

COMMIT;

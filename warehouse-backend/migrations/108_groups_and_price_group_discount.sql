-- Групи на продукти и партньори + отстъпка на ценова група
-- (искания по образец на Microinvest, 04.11.2026).
--
-- • Продуктите получават група (както „Група“ в Microinvest) — отделно от
--   категориите (вид храна), които ползват OCR подсказките и касовият
--   апарат. Група може да е „по доставчик“ (supplier_id): нова доставка
--   от него слага в нея продуктите, които още нямат група.
-- • Партньорите получават група; досегашната „Категория“ (Магазин /
--   Ресторант) става първите групи. Колоната category остава непипната.
-- • Всяка ценова група („Цена на едро“, „Ценова група 1“…) получава своя
--   отстъпка % — по подразбиране за новите редове в поръчка, освен ако
--   партньорът има своя отстъпка.
--
-- Само добавя: нови таблици и колони, попълнени от наличните данни.

CREATE TABLE IF NOT EXISTS product_groups (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS product_groups_name_key
  ON product_groups (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS product_groups_supplier_key
  ON product_groups (supplier_id) WHERE supplier_id IS NOT NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS product_group_id INTEGER
  REFERENCES product_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_product_group_id
  ON products (product_group_id);

CREATE TABLE IF NOT EXISTS partner_groups (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_groups_name_key
  ON partner_groups (lower(name));

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS partner_group_id INTEGER
  REFERENCES partner_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_partners_partner_group_id
  ON partners (partner_group_id);

CREATE TABLE IF NOT EXISTS price_group_discounts (
  price_group VARCHAR(50) PRIMARY KEY,
  discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (discount_percent >= 0 AND discount_percent <= 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO price_group_discounts (price_group) VALUES
  ('Цена на едро'), ('Цена на дребно'),
  ('Ценова група 1'), ('Ценова група 2'), ('Ценова група 3'),
  ('Ценова група 4'), ('Ценова група 5'), ('Ценова група 6'),
  ('Ценова група 7'), ('Ценова група 8')
ON CONFLICT DO NOTHING;

-- Група по доставчик за всеки доставчик с потвърдена доставка.
INSERT INTO product_groups (name, supplier_id)
SELECT regexp_replace(btrim(s.name), '\s+', ' ', 'g'), s.id
FROM suppliers s
WHERE btrim(coalesce(s.name, '')) <> ''
  AND EXISTS (
    SELECT 1
    FROM incoming_goods ig
    JOIN incoming_items ii ON ii.incoming_goods_id = ig.id
    WHERE ig.supplier_id = s.id
      AND ig.status = 'confirmed'
      AND ii.product_id IS NOT NULL
  )
ORDER BY s.id
ON CONFLICT DO NOTHING;

-- Доставените продукти без група → групата на последния им доставчик.
UPDATE products p
SET product_group_id = g.id
FROM (
  SELECT DISTINCT ON (ii.product_id) ii.product_id, ig.supplier_id
  FROM incoming_items ii
  JOIN incoming_goods ig ON ig.id = ii.incoming_goods_id
  WHERE ig.supplier_id IS NOT NULL
    AND ig.status = 'confirmed'
    AND ii.product_id IS NOT NULL
  ORDER BY ii.product_id, ig.created_at DESC, ig.id DESC
) last_delivery
JOIN product_groups g ON g.supplier_id = last_delivery.supplier_id
WHERE p.id = last_delivery.product_id
  AND p.product_group_id IS NULL;

-- Партньори: „Категория“ (Магазин / Ресторант) → групи.
INSERT INTO partner_groups (name)
SELECT DISTINCT btrim(category)
FROM partners
WHERE btrim(coalesce(category, '')) <> ''
ON CONFLICT DO NOTHING;

UPDATE partners p
SET partner_group_id = g.id
FROM partner_groups g
WHERE lower(g.name) = lower(btrim(p.category))
  AND p.partner_group_id IS NULL;

COMMENT ON COLUMN products.product_group_id IS
  'Група на продукта (като в Microinvest); NULL = без група';
COMMENT ON COLUMN product_groups.supplier_id IS
  'Група по доставчик: доставка от него слага тук продуктите без група';
COMMENT ON COLUMN partners.partner_group_id IS
  'Група на партньора; NULL = без група (старата колона category не се ползва)';
COMMENT ON TABLE price_group_discounts IS
  'Отстъпка % на ценова група — по подразбиране за новите редове в поръчка';

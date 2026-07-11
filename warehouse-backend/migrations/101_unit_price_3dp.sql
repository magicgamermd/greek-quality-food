-- 101: Единичните цени (доставни и продажни) минават на 3 знака след
-- запетаята — NUMERIC(10,2) → NUMERIC(12,3). Разширяване на точността е
-- обратно съвместимо: старите стойности не се променят, старият код
-- продължава да пише 2 знака без грешка.
--
-- СУМИТЕ остават с 2 знака (пари): incoming_items.total_price,
-- order_items.total_price, фактурните totals — НЕ се пипат тук.
-- batches.purchase_price и order_items.cost_unit_price вече са (12,4).
--
-- active_products е VIEW върху products → Postgres блокира ALTER TYPE на
-- колона, от която зависи view → drop + recreate (дефиницията е снета от
-- прод, 2026-07-11). product_batch_summary не пипа ценови колони.

DROP VIEW IF EXISTS active_products;

ALTER TABLE products ALTER COLUMN purchase_price TYPE NUMERIC(12,3);
ALTER TABLE products ALTER COLUMN selling_price TYPE NUMERIC(12,3);
ALTER TABLE incoming_items ALTER COLUMN unit_price TYPE NUMERIC(12,3);
ALTER TABLE incoming_items ALTER COLUMN selling_price TYPE NUMERIC(12,3);
ALTER TABLE order_items ALTER COLUMN unit_price TYPE NUMERIC(12,3);
ALTER TABLE price_list_items ALTER COLUMN price TYPE NUMERIC(12,3);
-- Себестойност на брак реда — следва точността на batches.purchase_price.
ALTER TABLE stock_writeoffs ALTER COLUMN unit_cost TYPE NUMERIC(12,3);

CREATE VIEW active_products AS
SELECT id,
    name_bg,
    name_en,
    sku,
    category_id,
    unit,
    description,
    image_url,
    low_stock_threshold,
    created_at,
    updated_at,
    brand,
    purchase_price,
    selling_price,
    microinvest_code,
    group_name,
    retail_price,
    price_group_1,
    price_group_2,
    price_group_3,
    price_group_4,
    price_group_5,
    price_group_6,
    price_group_7,
    price_group_8,
    print_name,
    vat_group,
    is_active,
    is_frequently_used,
    deleted_at,
    deleted_by
FROM products
WHERE deleted_at IS NULL;

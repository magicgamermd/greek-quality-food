-- Cleanup: remove 154 test products (created via web UI before Microinvest import)
-- + their dependent test orders + payments. Leaves only ПРОДУКТИ.txt content.

BEGIN;

-- Identify leftover test products (no Microinvest code, no NOC- synthetic prefix)
CREATE TEMP TABLE _leftover_products AS
SELECT id FROM products
 WHERE microinvest_code IS NULL
   AND sku NOT LIKE 'NOC-%';

CREATE TEMP TABLE _test_orders AS
SELECT DISTINCT order_id FROM order_items
 WHERE product_id IN (SELECT id FROM _leftover_products);

-- 1) Delete payments tied to test orders (FK is NO ACTION → would block)
DELETE FROM payments
 WHERE order_id IN (SELECT order_id FROM _test_orders);

-- 2) Delete test orders (cascades to order_items, NULLs comarch_sync.order_id)
DELETE FROM orders
 WHERE id IN (SELECT order_id FROM _test_orders);

-- 3) Delete the 154 leftover products (cascades inventory, batches, price_list_items, etc.)
DELETE FROM products
 WHERE id IN (SELECT id FROM _leftover_products);

-- Sanity check
DO $$
DECLARE
  prod_total INT; prod_with_mi INT; prod_noc INT; prod_other INT;
  inv_rows INT;
BEGIN
  SELECT COUNT(*) INTO prod_total   FROM products;
  SELECT COUNT(*) INTO prod_with_mi FROM products WHERE microinvest_code IS NOT NULL;
  SELECT COUNT(*) INTO prod_noc     FROM products WHERE sku LIKE 'NOC-%';
  SELECT COUNT(*) INTO prod_other   FROM products WHERE microinvest_code IS NULL AND sku NOT LIKE 'NOC-%';
  SELECT COUNT(*) INTO inv_rows     FROM inventory WHERE warehouse_id = 1;
  RAISE NOTICE 'products: total=%, with_mi=%, NOC=%, other=%   inventory_rows=%',
               prod_total, prod_with_mi, prod_noc, prod_other, inv_rows;
END $$;

COMMIT;

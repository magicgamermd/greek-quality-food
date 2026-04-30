-- Full wipe of products + everything that depends on them.
-- TRUNCATE CASCADE drains: products, inventory, batches, incoming_items,
-- order_items, price_list_items, product_aliases, stock_writeoffs.

BEGIN;

TRUNCATE TABLE products RESTART IDENTITY CASCADE;

DO $$
DECLARE
  prod INT; inv INT; oi INT; pli INT; pa INT; b INT; ii INT; sw INT;
BEGIN
  SELECT COUNT(*) INTO prod FROM products;
  SELECT COUNT(*) INTO inv  FROM inventory;
  SELECT COUNT(*) INTO oi   FROM order_items;
  SELECT COUNT(*) INTO pli  FROM price_list_items;
  SELECT COUNT(*) INTO pa   FROM product_aliases;
  SELECT COUNT(*) INTO b    FROM batches;
  SELECT COUNT(*) INTO ii   FROM incoming_items;
  SELECT COUNT(*) INTO sw   FROM stock_writeoffs;
  RAISE NOTICE 'After TRUNCATE: products=%  inventory=%  order_items=%  price_list_items=%  product_aliases=%  batches=%  incoming_items=%  stock_writeoffs=%',
               prod, inv, oi, pli, pa, b, ii, sw;
END $$;

COMMIT;

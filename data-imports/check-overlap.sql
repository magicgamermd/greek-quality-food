CREATE TEMP TABLE _import_skus(sku TEXT, code TEXT, name TEXT, unit TEXT, unit_raw TEXT, qty NUMERIC, p1 NUMERIC, p2 NUMERIC, p3 NUMERIC);
\copy _import_skus FROM '/tmp/produkti.csv' WITH (FORMAT csv, HEADER true)

SELECT 'sku_overlap' AS check, COUNT(*) AS n
  FROM products p JOIN _import_skus s ON s.sku = p.sku;

SELECT p.id, p.sku, p.name_bg, s.name AS import_name
  FROM products p JOIN _import_skus s ON s.sku = p.sku
 LIMIT 10;

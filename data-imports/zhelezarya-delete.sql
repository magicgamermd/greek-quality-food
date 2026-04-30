BEGIN;

DELETE FROM orders WHERE id = 97;

WITH deleted AS (
  DELETE FROM products WHERE group_name = 'ЖЕЛЕЗАРИЯ' RETURNING id
)
SELECT COUNT(*) AS products_deleted FROM deleted;

SELECT
  (SELECT COUNT(*) FROM products WHERE group_name = 'ЖЕЛЕЗАРИЯ') AS remaining_zhelezarya,
  (SELECT COUNT(*) FROM products) AS total_products,
  (SELECT COUNT(*) FROM orders WHERE id = 97) AS order_97_remaining,
  (SELECT COUNT(*) FROM order_items WHERE order_id = 97) AS order_items_97_remaining;

COMMIT;

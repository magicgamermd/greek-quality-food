-- ============================================================================
-- wipe-transactions.sql — върни stock-а в склада + изтрии всички поръчки
-- ============================================================================
--
-- Какво прави (в една транзакция):
--   1. Добавя обратно в inventory (warehouse_id=1) всичко, което
--      fulfilled/invoiced поръчки са изтегнали (line_status='normal' само).
--   2. Маха от inventory всичко, което incoming_items документи са добавили.
--   3. Маха от inventory нетния delta на razpiska_corrections.
--   4. DELETE-ва транзакционни таблици в правилен ред (НЕ TRUNCATE CASCADE
--      — то trunc-ва batches+inventory непредвидено).
--   5. Resetва ID sequence-ите.
--   6. ЗАПАЗВА: products, partners, suppliers, users, settings, warehouses,
--      categories, batches (с цените им), price_lists, price_list_items,
--      product_aliases, supplier_aliases, partner_order_objects, inventory.
--
-- Употреба (от хост машината):
--   docker cp data-imports/wipe-transactions.sql mertm-postgres-1:/tmp/wipe.sql
--   docker exec -it mertm-postgres-1 psql -U warehouse -d mertm_warehouse -f /tmp/wipe.sql
--   docker exec mertm-postgres-1 rm /tmp/wipe.sql
--
-- За dry-run: смени `COMMIT;` накрая на `ROLLBACK;`.
-- ============================================================================

BEGIN;

-- 1) Текущо състояние ---------------------------------------------------------
\echo
\echo '=== ПРЕДИ почистването ==='
SELECT 'orders' tbl, COUNT(*) cnt FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'invoices', COUNT(*) FROM invoices
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'incoming_goods', COUNT(*) FROM incoming_goods
UNION ALL SELECT 'incoming_items', COUNT(*) FROM incoming_items
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders
UNION ALL SELECT 'razpiska_corrections', COUNT(*) FROM razpiska_corrections
UNION ALL SELECT 'inventory NON-ZERO rows', COUNT(*) FROM inventory WHERE quantity <> 0
UNION ALL SELECT 'inventory total qty', SUM(quantity)::int FROM inventory
ORDER BY 1;

-- 2) Възстанови stock — добави обратно това, което deduct-натите поръчки са взели
WITH deducted AS (
  SELECT oi.product_id, SUM(oi.quantity) AS qty
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status IN ('fulfilled', 'invoiced')
    AND COALESCE(oi.line_status, 'normal') = 'normal'
  GROUP BY oi.product_id
)
UPDATE inventory inv
SET quantity   = inv.quantity + d.qty,
    updated_at = NOW()
FROM deducted d
WHERE inv.product_id   = d.product_id
  AND inv.warehouse_id = 1
  AND inv.batch_id IS NULL;

-- За продукти без inventory ред (rare), insert
INSERT INTO inventory (product_id, warehouse_id, batch_id, quantity, updated_at)
SELECT d.product_id, 1, NULL, d.qty, NOW()
FROM (
  SELECT oi.product_id, SUM(oi.quantity) AS qty
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status IN ('fulfilled', 'invoiced')
    AND COALESCE(oi.line_status, 'normal') = 'normal'
  GROUP BY oi.product_id
) d
WHERE NOT EXISTS (
  SELECT 1 FROM inventory inv2
  WHERE inv2.product_id = d.product_id
    AND inv2.warehouse_id = 1
    AND inv2.batch_id IS NULL
);

-- 3) Reverse incoming_goods -- махни stock-а, който incoming документи добавиха
WITH added AS (
  SELECT product_id, SUM(quantity) AS qty
  FROM incoming_items
  GROUP BY product_id
)
UPDATE inventory inv
SET quantity   = GREATEST(inv.quantity - a.qty, 0),
    updated_at = NOW()
FROM added a
WHERE inv.product_id   = a.product_id
  AND inv.warehouse_id = 1
  AND inv.batch_id IS NULL;

-- 4) Reverse razpiska_corrections (нетен delta)
WITH corr AS (
  SELECT product_id, SUM(quantity) AS qty
  FROM razpiska_correction_items
  GROUP BY product_id
)
UPDATE inventory inv
SET quantity   = inv.quantity - c.qty,
    updated_at = NOW()
FROM corr c
WHERE inv.product_id   = c.product_id
  AND inv.warehouse_id = 1
  AND inv.batch_id IS NULL;

-- 5) DELETE в правилен ред (razpiska FIRST — то реферира orders с NOT NULL).
--    НЕ ползваме TRUNCATE CASCADE — то cascade-ва и до batches+inventory!
DELETE FROM razpiska_correction_items;
DELETE FROM razpiska_corrections;     -- референцира orders с NOT NULL → trябва first
DELETE FROM payments;                 -- FK → orders, invoices (RESTRICT)
DELETE FROM comarch_sync;             -- FK → orders SET NULL — но wipe-ваме изцяло
DELETE FROM order_items;              -- CASCADE от orders, но експлицит
-- self-FK на orders: parent_order_id, replacement_of_order_id (nullable, NO ACTION)
UPDATE orders SET parent_order_id = NULL, replacement_of_order_id = NULL;
DELETE FROM orders;
DELETE FROM invoice_number_reservations;
-- self-FK на invoices: related_invoice_id (nullable, NO ACTION)
UPDATE invoices SET related_invoice_id = NULL;
DELETE FROM invoices;
DELETE FROM incoming_items;
DELETE FROM incoming_goods;          -- batches.delivery_id става NULL (запазват се!)
DELETE FROM purchase_order_items;
DELETE FROM purchase_orders;
DELETE FROM stock_writeoffs;
DELETE FROM notification_reads;
DELETE FROM notifications;
DELETE FROM audit_events;
DELETE FROM document_counters;
DELETE FROM import_logs;

-- 7) Resetни sequence-ите (за да следващата поръчка/фактура започне от 1)
ALTER SEQUENCE orders_id_seq RESTART WITH 1;
ALTER SEQUENCE order_items_id_seq RESTART WITH 1;
ALTER SEQUENCE invoices_id_seq RESTART WITH 1;
ALTER SEQUENCE payments_id_seq RESTART WITH 1;
ALTER SEQUENCE incoming_goods_id_seq RESTART WITH 1;
ALTER SEQUENCE incoming_items_id_seq RESTART WITH 1;
ALTER SEQUENCE purchase_orders_id_seq RESTART WITH 1;
ALTER SEQUENCE purchase_order_items_id_seq RESTART WITH 1;
ALTER SEQUENCE razpiska_corrections_id_seq RESTART WITH 1;
ALTER SEQUENCE razpiska_correction_items_id_seq RESTART WITH 1;
ALTER SEQUENCE stock_writeoffs_id_seq RESTART WITH 1;
ALTER SEQUENCE notifications_id_seq RESTART WITH 1;
ALTER SEQUENCE audit_events_id_seq RESTART WITH 1;

-- 8) Финално състояние --------------------------------------------------------
\echo
\echo '=== СЛЕД почистването ==='
SELECT 'orders' tbl, COUNT(*) cnt FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'invoices', COUNT(*) FROM invoices
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'incoming_goods', COUNT(*) FROM incoming_goods
UNION ALL SELECT 'incoming_items', COUNT(*) FROM incoming_items
UNION ALL SELECT 'purchase_orders', COUNT(*) FROM purchase_orders
UNION ALL SELECT 'razpiska_corrections', COUNT(*) FROM razpiska_corrections
UNION ALL SELECT 'inventory NON-ZERO rows', COUNT(*) FROM inventory WHERE quantity <> 0
UNION ALL SELECT 'inventory total qty', SUM(quantity)::int FROM inventory
UNION ALL SELECT 'products (preserved)', COUNT(*) FROM products
UNION ALL SELECT 'partners (preserved)', COUNT(*) FROM partners
UNION ALL SELECT 'batches (preserved)', COUNT(*) FROM batches
UNION ALL SELECT 'users (preserved)', COUNT(*) FROM users
ORDER BY 1;

\echo
\echo 'Готово. Ако числата изглеждат правилно, скриптът ще COMMIT-не сега.'
\echo

COMMIT;

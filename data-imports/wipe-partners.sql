-- Wipe all partners + all dependent test data (orders, invoices, payments).

BEGIN;

-- 1) Payments (RESTRICT vs invoices, NO ACTION vs orders) — drop first
DELETE FROM payments;

-- 2) Orders (cascades order_items; NULLs comarch_sync.order_id)
DELETE FROM orders;

-- 3) Invoices (cascades invoice_number_reservations; self-FK related_invoice_id resolves
--    inside the same DELETE because all invoices go away together)
DELETE FROM invoices;

-- 4) Partners (cascades partner_order_objects)
DELETE FROM partners;

DO $$
DECLARE
  p INT; o INT; oi INT; inv INT; pay INT; po INT;
BEGIN
  SELECT COUNT(*) INTO p   FROM partners;
  SELECT COUNT(*) INTO o   FROM orders;
  SELECT COUNT(*) INTO oi  FROM order_items;
  SELECT COUNT(*) INTO inv FROM invoices;
  SELECT COUNT(*) INTO pay FROM payments;
  SELECT COUNT(*) INTO po  FROM partner_order_objects;
  RAISE NOTICE 'partners=%  orders=%  order_items=%  invoices=%  payments=%  partner_objects=%',
               p, o, oi, inv, pay, po;
END $$;

COMMIT;

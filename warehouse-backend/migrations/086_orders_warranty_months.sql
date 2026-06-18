-- 083_orders_warranty_months.sql
-- Stores the chosen warranty duration (in months) on the order so the
-- cashier can see at a glance how long the warranty runs — without
-- having to re-open the cached PDF — and the order detail "Гаранция №"
-- box can show "WR-… · 24 мес." next to the number.
--
-- Default 12 months is the most common; the frontend lets the user
-- pick 6 / 12 / 24 from a dropdown next to the "Гаранция" button.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS warranty_months INTEGER;

-- Backfill existing issued warranties with 12 (the previous hard-coded
-- default in /orders/:id/warranty-pdf) so the UI doesn't render NULL.
UPDATE orders
   SET warranty_months = 12
 WHERE warranty_issued_at IS NOT NULL
   AND warranty_months IS NULL;

COMMIT;

-- 081_orders_warehouse_confirmed_at.sql
-- Tracks "складът физически потвърди предаване/опаковане" — set ONLY when
-- the warehouse worker presses "Потвърди изпращане" in /warehouse-packing.
--
-- Decoupled from the status='fulfilled' transition because the fulfill
-- endpoint is called from two places:
--   1. Office drawer "Изпълни поръчка" — back-office shortcut, NOT a
--      warehouse confirmation (clerk may not have physically packed).
--   2. /warehouse-packing "Потвърди изпращане" — warehouse worker has
--      actually packed and is handing over the goods. THIS is what flips
--      the badge to green.
--
-- Backfill: existing fulfilled/invoiced orders are assumed already
-- handed over (otherwise nothing would show green and the office would
-- panic on Monday morning). Use updated_at as best-effort timestamp.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS warehouse_confirmed_at TIMESTAMPTZ;

UPDATE orders
   SET warehouse_confirmed_at = updated_at
 WHERE warehouse_confirmed_at IS NULL
   AND status IN ('fulfilled', 'invoiced');

COMMIT;

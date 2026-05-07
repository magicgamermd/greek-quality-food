-- 055_orders_dispatched_to_warehouse_at.sql
-- Tracks "пуснах поръчката към склад да я приготви" as a flag, decoupled
-- from the confirmed → processing → fulfilled status transitions.
--
-- Reason: sales staff often have the goods on hand and fulfill the order
-- without involving the warehouse team. The "Изпрати към склад" button
-- must remain visible at all statuses (not just confirmed) so it can be
-- used as a deliberate notify-warehouse action, not a forced workflow step.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS dispatched_to_warehouse_at TIMESTAMPTZ;

-- Backfill: any non-pending/non-cancelled order that already moved past
-- confirmed must have been dispatched at some point. Use updated_at as a
-- best-effort timestamp (precise dispatch time was never recorded).
UPDATE orders
   SET dispatched_to_warehouse_at = updated_at
 WHERE dispatched_to_warehouse_at IS NULL
   AND status IN ('processing', 'fulfilled', 'invoiced');

COMMIT;

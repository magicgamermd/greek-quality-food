-- 065_notifications_payload.sql
-- Adds an optional structured payload to notifications so handlers can
-- carry typed context (order_id, item_id, etc.) instead of stuffing
-- everything into the free-text message.
--
-- Used initially by Batch F1 'pending_order_ready' notifications fired
-- from the incoming-confirm handler when stock arrives for paid_not_taken
-- or awaiting lines.

BEGIN;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS payload JSONB;

COMMIT;

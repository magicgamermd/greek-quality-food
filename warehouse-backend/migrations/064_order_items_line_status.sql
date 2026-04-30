-- 064_order_items_line_status.sql
-- Per-line state on order_items:
--   'normal'         (default) — standard stock-deducting line
--   'paid_not_taken' — customer paid; goods not handed over; deducts stock
--                      (allowed negative — promised inventory)
--   'awaiting'       — pre-order (no payment, no stock effect)

BEGIN;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS line_status TEXT NOT NULL DEFAULT 'normal'
    CHECK (line_status IN ('normal', 'paid_not_taken', 'awaiting'));

-- Partial index keeps the index tiny (most rows are 'normal').
CREATE INDEX IF NOT EXISTS idx_order_items_line_status_pending
  ON order_items(line_status)
  WHERE line_status != 'normal';

COMMIT;

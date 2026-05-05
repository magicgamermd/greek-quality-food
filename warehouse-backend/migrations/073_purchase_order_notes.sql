-- 073_purchase_order_notes.sql
-- Adds the "note" layer: lightweight pre-purchase-order entries that get
-- merged into a real PO via /merge.

ALTER TABLE purchase_orders
  DROP CONSTRAINT purchase_orders_status_check;

ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('note', 'draft', 'sent', 'received'));

-- Optional free-text label for notes (e.g., "Кухня в Хемус").
ALTER TABLE purchase_orders
  ADD COLUMN label TEXT;

-- How many notes were folded into this entry (0 for direct drafts/notes,
-- ≥1 for orders produced by /merge). Pure UI metadata — no logic depends
-- on it.
ALTER TABLE purchase_orders
  ADD COLUMN merged_from_count INTEGER NOT NULL DEFAULT 0;

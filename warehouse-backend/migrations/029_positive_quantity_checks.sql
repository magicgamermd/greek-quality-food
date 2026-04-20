-- Sprint 2-3: CHECK constraints for quantity / price invariants.
-- Existing data was verified to satisfy these constraints (all counts = 0)
-- on 2026-04-17 before this migration was written. If that ever becomes
-- untrue on another environment, re-add the constraint as NOT VALID and
-- fix the offending rows before VALIDATE CONSTRAINT.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inventory_qty_nonneg') THEN
    ALTER TABLE inventory
      ADD CONSTRAINT chk_inventory_qty_nonneg CHECK (quantity >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_batches_qty_nonneg') THEN
    ALTER TABLE batches
      ADD CONSTRAINT chk_batches_qty_nonneg CHECK (quantity >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_items_qty_pos') THEN
    ALTER TABLE order_items
      ADD CONSTRAINT chk_order_items_qty_pos CHECK (quantity > 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_items_price_nonneg') THEN
    ALTER TABLE order_items
      ADD CONSTRAINT chk_order_items_price_nonneg CHECK (unit_price >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_incoming_items_qty_pos') THEN
    ALTER TABLE incoming_items
      ADD CONSTRAINT chk_incoming_items_qty_pos CHECK (quantity > 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_incoming_items_price_nonneg') THEN
    ALTER TABLE incoming_items
      ADD CONSTRAINT chk_incoming_items_price_nonneg CHECK (unit_price >= 0);
  END IF;
END $$;

-- Invoices: total_net must be non-negative except for credit notes where the
-- net value may legitimately be negative.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_totals') THEN
    ALTER TABLE invoices
      ADD CONSTRAINT chk_invoices_totals
      CHECK (total_net >= 0 OR document_type = 'credit_note');
  END IF;
END $$;

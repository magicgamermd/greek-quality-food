-- Sprint 2-3: Uniqueness constraints.
-- NOTE on ux_batches_product_number:
--   Some environments contain duplicate (product_id, batch_number) rows.
--   To keep this migration additive and safe to auto-apply, we first
--   consolidate duplicates by keeping the oldest row (lowest id) and
--   merging quantity into it. If you need different behaviour, revert
--   the de-dup block below and run it manually.

-- --- 1. Partner EIK uniqueness (only for rows with EIK populated) ---------
CREATE UNIQUE INDEX IF NOT EXISTS ux_partners_eik
  ON partners(eik)
  WHERE eik IS NOT NULL AND eik <> '';

-- --- 2. At most one credit note per original invoice ----------------------
CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_note_per_invoice
  ON invoices(related_invoice_id)
  WHERE document_type = 'credit_note';

-- --- 3. Defensive uniqueness on invoice_number ----------------------------
-- invoices_invoice_number_key already exists as UNIQUE CONSTRAINT from 001.
-- Create an explicit unique index under the canonical name only if missing.
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_number
  ON invoices(invoice_number);

-- --- 4. Batch uniqueness per product -------------------------------------
-- De-dup existing duplicates first. Strategy: keep MIN(id) row, sum
-- quantities from the duplicates into it, then delete the duplicates.
-- Because batches is referenced by order_items/incoming_items/inventory
-- via ON DELETE SET NULL, we first repoint those FKs to the kept row.
DO $$
DECLARE
  rec RECORD;
  keep_id INT;
BEGIN
  FOR rec IN
    SELECT product_id, batch_number
    FROM batches
    WHERE batch_number IS NOT NULL
    GROUP BY product_id, batch_number
    HAVING COUNT(*) > 1
  LOOP
    SELECT MIN(id) INTO keep_id
    FROM batches
    WHERE product_id = rec.product_id
      AND batch_number = rec.batch_number;

    -- Repoint children
    UPDATE inventory       SET batch_id = keep_id
      WHERE batch_id IN (SELECT id FROM batches
                          WHERE product_id = rec.product_id
                            AND batch_number = rec.batch_number
                            AND id <> keep_id);
    UPDATE order_items     SET batch_id = keep_id
      WHERE batch_id IN (SELECT id FROM batches
                          WHERE product_id = rec.product_id
                            AND batch_number = rec.batch_number
                            AND id <> keep_id);
    UPDATE incoming_items  SET batch_id = keep_id
      WHERE batch_id IN (SELECT id FROM batches
                          WHERE product_id = rec.product_id
                            AND batch_number = rec.batch_number
                            AND id <> keep_id);

    -- Consolidate quantity into the kept row
    UPDATE batches b
       SET quantity = (
         SELECT COALESCE(SUM(quantity), 0)
         FROM batches
         WHERE product_id = rec.product_id
           AND batch_number = rec.batch_number
       )
     WHERE b.id = keep_id;

    -- Delete duplicates
    DELETE FROM batches
     WHERE product_id = rec.product_id
       AND batch_number = rec.batch_number
       AND id <> keep_id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_batches_product_number
  ON batches(product_id, batch_number)
  WHERE batch_number IS NOT NULL;

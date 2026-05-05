-- Batch D follow-up — persist the invoice receiver override at the order
-- level so it applies to *every* transaction document (Стокова разписка,
-- Оферта, Приемо-предавателен протокол, Търговски документ) the moment the
-- cashier picks "Издай на фирма", not just after the invoice itself is
-- generated.
--
-- Until now, the override only existed on `invoices.partner_id` once the
-- invoice was created, so a Стокова разписка printed on a confirmed (but
-- not-yet-invoiced) order kept showing the original individual customer.
-- With this column the same override value drives every document and the
-- drawer header, regardless of whether the invoice has been generated yet.
--
-- Semantics:
--   * NULL                                         → no override, use o.partner_id
--   * NOT NULL & = o.partner_id                    → no-op (same partner picked)
--   * NOT NULL & <> o.partner_id                   → override is in effect
--
-- ON DELETE SET NULL because the underlying companies table can be cleaned
-- up independently; the order should not be lost just because the override
-- partner was deleted from the catalog.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS invoice_partner_id INTEGER
    REFERENCES partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_invoice_partner_id
  ON orders(invoice_partner_id)
  WHERE invoice_partner_id IS NOT NULL;

COMMENT ON COLUMN orders.invoice_partner_id IS
  'Override receiver for transaction documents (Batch D). When set, supersedes orders.partner_id on the invoice, Стокова разписка, Оферта and ППП. Decoupled from orders.invoice_id so the override applies before the invoice is created and survives invoice deletion.';

-- Backfill existing orders that already had an invoice with a different
-- partner (the previous "derive from invoice" behaviour). This keeps prior
-- documents consistent with their invoice after the upgrade.
UPDATE orders o
   SET invoice_partner_id = inv.partner_id
  FROM invoices inv
 WHERE inv.id = o.invoice_id
   AND inv.status <> 'cancelled'
   AND inv.partner_id <> o.partner_id
   AND o.invoice_partner_id IS NULL;

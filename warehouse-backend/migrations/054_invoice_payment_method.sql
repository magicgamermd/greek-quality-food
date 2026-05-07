-- 054_invoice_payment_method.sql
-- Adds payment_method column to invoices: how the buyer is asked to pay.
--
-- Note: this is distinct from payments.payment_method (which records HOW a
-- payment was actually executed). invoices.payment_method describes the
-- payment basis printed on the invoice PDF — "Начин на плащане:".
--
-- Values:
--   'cash' → "В брой"
--   'bank' → "Банков превод" (default — most common for B2B)
--   'cod'  → "Наложен платеж" (cash-on-delivery)

BEGIN;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'bank';

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_payment_method_check;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_payment_method_check
  CHECK (payment_method IN ('cash', 'bank', 'cod'));

COMMIT;

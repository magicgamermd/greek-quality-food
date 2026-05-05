-- 070_payments_method_cod.sql
-- Allow payment_method='cod' on the payments table.
--
-- The original 001_initial.sql CHECK constrained payments.payment_method
-- to ('cash','bank','card'). Later code (orders.ts aggregates
-- SUM(amount) WHERE payment_method='cod' into paid_cod_amount; the
-- "Наложен платеж" modal in the frontend submits method='cod' for COD
-- orders) and 054_invoice_payment_method.sql implicitly assume 'cod'
-- is a valid recorded method, but the constraint here was never
-- updated — every COD-method payment write failed with a check-
-- violation surfaced as a generic "Грешка при запазване" toast.
--
-- Note: 'card' stays in the allowed set because earlier code paths
-- already write it for terminal/POS payments; we're additive only.

BEGIN;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_payment_method_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_payment_method_check
  CHECK (payment_method IN ('cash', 'bank', 'card', 'cod'));

COMMIT;

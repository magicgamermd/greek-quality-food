-- Add POS as a payment method everywhere it can appear, and rename the
-- legacy `card` value on payments → `pos` so the term is consistent
-- across invoices, payments, fiscal printer and the daily report.
--
-- Why two changes in one migration:
--  1. invoices.payment_method previously had no card/pos option — this
--     adds 'pos' to the CHECK so invoices can be issued for POS-terminal
--     transactions.
--  2. payments.payment_method had 'card' but never matched any UI label;
--     keep one term ("ПОС") everywhere by collapsing 'card' into 'pos'.
--     Existing 'card' rows are migrated in the same statement.
--
-- Both CHECKs are dropped/re-added rather than ALTER-ed because Postgres
-- doesn't support modifying enum-style CHECK lists in place.

-- ── invoices.payment_method ────────────────────────────────
ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_payment_method_check;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_payment_method_check
  CHECK (payment_method IN ('cash', 'bank', 'cod', 'pos'));

-- ── payments.payment_method ────────────────────────────────
ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_payment_method_check;

UPDATE payments
   SET payment_method = 'pos'
 WHERE payment_method = 'card';

ALTER TABLE payments
  ADD CONSTRAINT payments_payment_method_check
  CHECK (payment_method IN ('cash', 'bank', 'cod', 'pos'));

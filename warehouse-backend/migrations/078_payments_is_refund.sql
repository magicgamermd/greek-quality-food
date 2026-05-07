-- 078_payments_is_refund.sql
-- Adds is_refund flag to payments. Used by replacement orders when
-- the difference is in the customer's favour (we return money). amount
-- stays positive; is_refund=true means cash flows OUT of the till.
-- See docs/superpowers/specs/2026-05-07-product-replacement-design.md

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS is_refund BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN payments.is_refund IS
  'When true, this payment represents money RETURNED to the customer (cash out). Used for negative-difference replacements and cancel-mirror entries.';

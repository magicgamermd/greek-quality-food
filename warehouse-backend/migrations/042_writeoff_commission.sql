-- Migration 042: Commission members for write-off protocols
--
-- Bulgarian tax law (Закон за счетоводството чл. 54 ал. 1 + НАП inventory
-- rules) requires that every stock write-off protocol is signed by a
-- 3-member commission (председател + 2 членове). For ООД/ЕООД entities
-- this is strictly enforced during НАП audits — missing signatures
-- mean the write-off is refused as a tax-deductible expense.
--
-- Instead of making the user manually type the 3 names on every printed
-- protocol, we store their default names on `settings` so the PDF
-- renderer can pre-fill them. Blank signature lines remain for the ink
-- signatures themselves.

BEGIN;

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS writeoff_commission_chair   TEXT,
  ADD COLUMN IF NOT EXISTS writeoff_commission_member1 TEXT,
  ADD COLUMN IF NOT EXISTS writeoff_commission_member2 TEXT;

COMMIT;

-- No default values — an un-configured system prints empty signature lines
-- just like before, preserving backward compatibility with existing setups.

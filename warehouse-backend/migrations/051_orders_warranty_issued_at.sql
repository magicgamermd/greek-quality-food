-- 051_orders_warranty_issued_at.sql
-- Tracks whether a warranty card has been issued for an order so the
-- order detail view can show "Гаранция № WR-XXXXXXX" next to the other
-- document numbers (Стокова №, Търговски №). Warranties themselves
-- stay stateless (the PDF is still generated on demand from the order
-- number); this column only records the first-issuance timestamp.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS warranty_issued_at TIMESTAMPTZ NULL;

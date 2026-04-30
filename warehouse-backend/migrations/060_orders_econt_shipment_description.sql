-- 060: persist Econt shipment description ("Съдържание на пратката")
-- so each waybill captures what's being shipped instead of falling back
-- to the hard-coded "Кухненско оборудване". Free-text TEXT field.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS econt_shipment_description TEXT;

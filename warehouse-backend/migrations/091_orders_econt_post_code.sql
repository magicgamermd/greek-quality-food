-- Persist the Econt city post code selected from getCities.
-- Econt address labels require city.name + city.postCode; without persisting
-- this field, saved orders could later create/update a waybill with a weaker
-- receiverAddress than the one used during the original calculation.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS econt_post_code VARCHAR(20);

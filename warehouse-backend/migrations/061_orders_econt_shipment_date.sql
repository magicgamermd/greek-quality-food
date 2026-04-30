-- 061: persist Econt shipmentDate ("Дата на доставка") so address-based
-- shipments can carry the date through update-shipment / regenerated
-- labels. Stored as DATE; backend defaults to tomorrow when NULL.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS econt_shipment_date DATE;

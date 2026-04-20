-- MERT-M Econt shipping fields (v0.2.0).
-- Columns use demo naming convention (econt_office_code + econt_office_name
-- instead of a single econt_office) for precision.
-- Legacy columns from 019_order_econt_fields.sql (econt_office, econt_tracking)
-- stay as vestigial/deprecated — drop planned for v1.1.

COMMENT ON COLUMN orders.econt_office IS
  'DEPRECATED v0.2.0 — use econt_office_code + econt_office_name instead. Will be dropped in v1.1.';
COMMENT ON COLUMN orders.econt_tracking IS
  'DEPRECATED v0.2.0 — use econt_shipment_number + econt_tracking_url instead. Will be dropped in v1.1.';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_receiver_name   VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_receiver_phone  VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_delivery_type   VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_office_code     VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_office_name     VARCHAR(500);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_street          VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_street_num      VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_cod_amount      NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_weight          NUMERIC(10,3);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_shipping_cost   NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_shipment_number VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_tracking_url    TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_pdf_url         TEXT;

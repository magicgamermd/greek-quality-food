-- 024: Add order metadata filters + partner-scoped reusable objects/stores

CREATE TABLE IF NOT EXISTS partner_order_objects (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  object_name VARCHAR(255) NOT NULL,
  object_code VARCHAR(100) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'partner_order_objects_object_name_not_blank'
  ) THEN
    ALTER TABLE partner_order_objects
      ADD CONSTRAINT partner_order_objects_object_name_not_blank
      CHECK (BTRIM(object_name) <> '');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_partner_order_objects_partner_id
  ON partner_order_objects(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_order_objects_name_ci
  ON partner_order_objects(LOWER(object_name));
CREATE INDEX IF NOT EXISTS idx_partner_order_objects_code_ci
  ON partner_order_objects(LOWER(object_code));
CREATE UNIQUE INDEX IF NOT EXISTS ux_partner_order_objects_partner_name_code_ci
  ON partner_order_objects (
    partner_id,
    LOWER(BTRIM(object_name)),
    LOWER(BTRIM(object_code))
  );

ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_number VARCHAR(120);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS partner_object_id INTEGER
  REFERENCES partner_order_objects(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS object_name VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS object_code VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_orders_request_number_ci
  ON orders(LOWER(request_number));
CREATE INDEX IF NOT EXISTS idx_orders_partner_object_id
  ON orders(partner_object_id);
CREATE INDEX IF NOT EXISTS idx_orders_object_name_ci
  ON orders(LOWER(object_name));
CREATE INDEX IF NOT EXISTS idx_orders_object_code_ci
  ON orders(LOWER(object_code));

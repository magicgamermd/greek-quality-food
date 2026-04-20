-- Sprint 2-3: Auto-maintain updated_at on UPDATE for core business tables.
-- Only installs triggers on tables that actually have an updated_at column.
-- (invoices and payments currently do not — left out of the loop.)

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
  candidates TEXT[] := ARRAY[
    'orders', 'products', 'partners', 'inventory',
    'batches', 'incoming_goods', 'suppliers', 'settings',
    'price_lists', 'product_aliases', 'users', 'partner_order_objects'
  ];
BEGIN
  FOREACH t IN ARRAY candidates LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = t
         AND column_name = 'updated_at'
    ) THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I',
        t, t
      );
      EXECUTE format(
        'CREATE TRIGGER trg_%I_updated_at '
        'BEFORE UPDATE ON %I '
        'FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        t, t
      );
    END IF;
  END LOOP;
END $$;

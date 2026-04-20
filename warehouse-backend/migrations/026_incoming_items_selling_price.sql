ALTER TABLE incoming_items
  ADD COLUMN IF NOT EXISTS selling_price NUMERIC(10,2);

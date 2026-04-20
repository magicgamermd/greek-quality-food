-- Add sequential order_number column (no gaps, unlike auto-increment id)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number INT;

-- Create a sequence for order numbers
CREATE SEQUENCE IF NOT EXISTS order_number_seq;

-- Backfill existing orders with sequential numbers based on creation order
DO $$
DECLARE
  r RECORD;
  seq_val INT := 0;
BEGIN
  FOR r IN SELECT id FROM orders ORDER BY created_at ASC, id ASC LOOP
    seq_val := seq_val + 1;
    UPDATE orders SET order_number = seq_val WHERE id = r.id;
  END LOOP;
  -- Set the sequence to the next value
  IF seq_val > 0 THEN
    PERFORM setval('order_number_seq', seq_val);
  END IF;
END $$;

-- Set default for new orders
ALTER TABLE orders ALTER COLUMN order_number SET DEFAULT nextval('order_number_seq');

-- Add unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number) WHERE order_number IS NOT NULL;

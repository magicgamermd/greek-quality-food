ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS econt_receiver_is_company BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS econt_receiver_company_name VARCHAR(255);

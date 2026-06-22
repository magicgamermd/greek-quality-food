-- Групиране на много брак-редове в един протокол (един НАП акт).
ALTER TABLE stock_writeoffs ADD COLUMN IF NOT EXISTS protocol_number VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_writeoffs_protocol
  ON stock_writeoffs(protocol_number) WHERE protocol_number IS NOT NULL;

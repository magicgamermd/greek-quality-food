ALTER TABLE incoming_goods
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS idempotency_request_hash CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS incoming_goods_idempotency_key_key
  ON incoming_goods (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

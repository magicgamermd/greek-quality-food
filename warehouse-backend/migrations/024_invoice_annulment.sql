-- Invoice annulment/cancellation lifecycle
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_status_check;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('active', 'cancelled'));

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

UPDATE invoices
SET status = 'active'
WHERE status IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

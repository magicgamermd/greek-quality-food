-- Extend the "client_display" override fields on invoices with EGN
-- (national ID) and address. Used when the invoice receiver is a named
-- physical person whose details aren't stored as a partner row — keeps
-- the invoice valid for accounting without polluting partners with
-- one-off retail customers.
--
-- All three client_display_* columns are mutually exclusive with the
-- partner-override path (Batch D). Server enforces: when an override
-- partner is set, client_display_* are nulled.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS client_display_egn VARCHAR(20);

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS client_display_address TEXT;

COMMENT ON COLUMN invoices.client_display_egn IS
  'EGN/ЕГН of the named individual receiver (no partner row). Mutually exclusive with partner override.';

COMMENT ON COLUMN invoices.client_display_address IS
  'Address of the named individual receiver (no partner row). Mutually exclusive with partner override.';

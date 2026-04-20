-- Fiscal printer settings columns
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_connection_type TEXT DEFAULT 'fpgate';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_fpgate_url TEXT DEFAULT 'http://localhost:8182';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_printer_id TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_serial_port TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_auto_print BOOLEAN DEFAULT FALSE;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_operator_id TEXT DEFAULT '1';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS fiscal_operator_password TEXT DEFAULT '0000';

-- Track fiscal receipt status on invoices
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fiscal_status TEXT DEFAULT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fiscal_receipt_number TEXT DEFAULT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fiscal_printed_at TIMESTAMPTZ DEFAULT NULL;

-- Track fiscal receipt on orders (for direct receipt printing without invoice)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_printed BOOLEAN DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_printed_at TIMESTAMPTZ DEFAULT NULL;

-- Zebra label-printer name (CUPS queue name on the host running the
-- backend). Used by the /print/zebra endpoint to send Econt waybills
-- and stock-dispatch labels directly to the Zebra without going through
-- the browser's print dialog. NULL = feature disabled (fall back to
-- regular browser printing).
--
-- The actual printer queue is configured at the OS level (System Settings
-- → Printers & Scanners on macOS). Just the queue name is stored here.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS zebra_printer_name TEXT;

COMMENT ON COLUMN settings.zebra_printer_name IS
  'CUPS queue name for the Zebra label printer (waybills + stock dispatch). NULL → feature off, browser print dialog used.';

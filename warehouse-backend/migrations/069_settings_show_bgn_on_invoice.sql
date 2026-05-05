-- Adds a boolean toggle on the global settings row that controls whether
-- the invoice PDF should print BGN amounts alongside the primary EUR
-- figures. Bulgaria adopted the euro on 2026-01-01, but customers are
-- still used to seeing the lev value on receipts during the transition
-- period; toggling this off later cleans up the printout once the
-- dual-currency convenience is no longer needed.
--
-- Default `false`: existing invoices keep printing exactly as they do
-- today until the cashier explicitly opts in.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS show_bgn_on_invoice BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN settings.show_bgn_on_invoice IS
  'When true, invoice PDFs print BGN equivalents next to the EUR amounts (fixed BNB rate 1 EUR = 1.95583 BGN). Per-tenant toggle in Settings → Документи.';

-- Who pays Econt shipping services: 'sender' (we pay) or 'receiver' (customer pays).
-- Drives Econt servicesPayer in createLabel and shipping-cost attribution in reports.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS econt_payer VARCHAR(20);

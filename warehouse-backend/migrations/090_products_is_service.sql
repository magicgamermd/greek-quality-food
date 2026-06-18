-- 087_products_is_service.sql
-- "Service" flag за продукти които не са физически артикули, а услуги:
-- комисионни, ремонти, транспортни такси, обучения и т.н.
--
-- Когато is_service=TRUE:
--   • Fulfill flow НЕ изтегля stock (deductProductStock се пропуска)
--   • Inventory никога не става отрицателно за тези "продукти"
--   • Не са нужни admin overrides за продажба на минус
--   • COGS снимка cost_unit_price остава NULL (няма доставна цена за услуга)
--   • Incoming flow също трябва да ги skip-ва (нямa физическа доставка)
--
-- За UI: показва маркер 🛠 (или icon) при service продукти, hide-ва "stock"
-- колоната в product list, не показва oversell warning.
--
-- Default FALSE — съществуващите физически артикули остават непроменени.
-- Касиерката маркира продукт като service при създаване/редакция.

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_service BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index — обикновено малък процент от продуктите са услуги,
-- partial index по TRUE стойностите е по-малък и по-бърз.
CREATE INDEX IF NOT EXISTS idx_products_is_service
  ON products (id)
  WHERE is_service = TRUE;

COMMIT;

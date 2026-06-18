-- 090_orders_econt_requested.sql
-- Flag за поръчки, които касиерът маркира "за Еконт доставка".
-- Огледало на dispatched_to_warehouse_at (склад flow). Когато е NOT NULL,
-- поръчката се появява в опашката на Еконт работника (/econt). Той въвежда
-- данните за доставка, прави товарителница и следи наложения платеж.
--
-- Независим от dispatched_to_warehouse_at — поръчка може да е за склад
-- И/ИЛИ за Еконт.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS econt_requested_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_econt_requested
  ON orders (econt_requested_at)
  WHERE econt_requested_at IS NOT NULL;

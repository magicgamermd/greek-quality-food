-- 084_orders_created_by.sql
-- Tracks which user (admin / sales / accountant / warehouse) created
-- the order, so the "Източник" колоната в Поръчки списъка показва
-- "Иван Петров" / "Мария Иванова" вместо безсмислените "manual" /
-- "assistant" badges. Самата стокова разписка също чете това поле и
-- го печата в полето "Съставил".
--
-- created_by е UUID FK към users. ON DELETE SET NULL — ако потребител
-- бъде изтрит (рядко), поръчките му остават, само името се скрива.
-- Стари поръчки преди тази миграция нямат запис → "Източник" показва
-- източника (assistant/manual) като fallback (виж Orders.tsx).

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_created_by
  ON orders (created_by)
  WHERE created_by IS NOT NULL;

COMMIT;

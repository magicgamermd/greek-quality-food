-- 088_stock_movements.sql
-- Ръчни inventory adjustments — отделно от orders/incoming flow-овете.
--
-- Use cases:
--   • Завеждане ('in'): доставка без фактура, корекция инвентаризация,
--     връщане от клиент без credit note, безплатен sample
--   • Изписване ('out'): брак, експирация, кражба, лично ползване, подарък
--
-- За разлика от incoming_goods (изисква supplier + invoice) и orders
-- (изисква partner + цена), тук flow-ът е минимален: продукт + количество
-- + причина. Audit trail включва кой го е направил и snapshot на
-- наличността преди/след за по-лесна reconciliation.
--
-- Една таблица за in + out (а не две отделни) — unified history view,
-- по-лесни справки и export. Полето `movement_type` различава.
--
-- Permission: STOCK_MOVEMENTS_MANAGE (нов в migration 087+). Default:
-- admin + accountant. Warehouse role е изключен (нямa достъп до тази
-- секция изобщо).

BEGIN;

CREATE TABLE IF NOT EXISTS stock_movements (
  id                  SERIAL PRIMARY KEY,
  product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  warehouse_id        INTEGER NOT NULL DEFAULT 1 REFERENCES warehouses(id),
  -- Тип на движение. 'in' добавя количество, 'out' изважда.
  movement_type       VARCHAR(10) NOT NULL CHECK (movement_type IN ('in', 'out')),
  -- Винаги положително. Знакът се определя от movement_type.
  quantity            NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  -- Snapshot на inventory ПРЕДИ и СЛЕД операцията. Полезно за audit
  -- reconciliation — касиерката може да види "налично 15 → 12" без
  -- да трябва да изчислява назад от текущото състояние.
  quantity_before     NUMERIC(12, 3) NOT NULL,
  quantity_after      NUMERIC(12, 3) NOT NULL,
  -- Причина (enum-like dropdown). Свободният текст отива в note.
  reason              VARCHAR(50) NOT NULL,
  note                TEXT,
  -- Кой направи операцията. ON DELETE SET NULL за да оцелее ако
  -- потребителят бъде изтрит (рядко, но запазваме history).
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Индекси за най-честите справки:
--   1. Per-product history (виж всички движения на продукт X)
--   2. Time-range filter (виж всичко от/до дата)
--   3. Per-user audit (кой какво е правил)
--   4. Combined filter (продукт + период) — covered by composite
CREATE INDEX IF NOT EXISTS idx_stock_movements_product
  ON stock_movements (product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at
  ON stock_movements (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_user
  ON stock_movements (created_by, created_at DESC)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_type
  ON stock_movements (movement_type, created_at DESC);

COMMIT;

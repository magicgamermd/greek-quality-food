-- 098_batch_inventory_fefo.sql
-- Партидно проследяване: order_item_batches, batch/expiry на incoming_items,
-- прехвърляне на текущата (NULL-партида) наличност в синтетична откриваща партида.
-- ЗАБ.: runner-ът (migrate.ts) сам обвива файла в BEGIN/COMMIT — без собствена транзакция тук.

-- 1) Разпределение поръчков ред -> партиди (източник за търговския документ + COGS)
CREATE TABLE IF NOT EXISTS order_item_batches (
  id            SERIAL PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  batch_id      INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  quantity      NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost     DECIMAL(12,4) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oib_order_item ON order_item_batches(order_item_id);
CREATE INDEX IF NOT EXISTS idx_oib_batch      ON order_item_batches(batch_id);

-- 2) Заснемане на въведени партида/срок на входящия ред (преди confirm)
ALTER TABLE incoming_items ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100);
ALTER TABLE incoming_items ADD COLUMN IF NOT EXISTS expiry_date  DATE;

-- 3a) Партидите следват политиката от 052 (allow negative inventory): махаме non-neg
--     CHECK, за да може откриващата партида да отрази евент. отрицателна (oversold) наличност.
ALTER TABLE batches DROP CONSTRAINT IF EXISTS chk_batches_qty_nonneg;

-- 3) Откриваща партида: прехвърля NULL-партида наличност в партида 'НАЧАЛНО'
DO $$
DECLARE r RECORD; v_batch_id INTEGER;
BEGIN
  FOR r IN SELECT DISTINCT product_id FROM inventory WHERE batch_id IS NULL AND quantity <> 0
  LOOP
    SELECT id INTO v_batch_id FROM batches
      WHERE product_id = r.product_id AND batch_number = 'НАЧАЛНО' LIMIT 1;
    IF v_batch_id IS NULL THEN
      INSERT INTO batches (product_id, batch_number, expiry_date, quantity, purchase_price, received_date, notes)
      SELECT r.product_id, 'НАЧАЛНО', NULL, 0, COALESCE(p.purchase_price, 0), CURRENT_DATE,
             'Откриваща наличност (миграция 098)'
      FROM products p WHERE p.id = r.product_id
      RETURNING id INTO v_batch_id;
    END IF;
    -- прехвърля всички NULL-партида редове на продукта (всички складове) към откриващата
    UPDATE inventory SET batch_id = v_batch_id, updated_at = NOW()
      WHERE product_id = r.product_id AND batch_id IS NULL;
    -- съгласува batches.quantity = сума на наличността по тази партида
    UPDATE batches SET quantity = (
      SELECT COALESCE(SUM(quantity), 0) FROM inventory WHERE batch_id = v_batch_id
    ), updated_at = NOW() WHERE id = v_batch_id;
  END LOOP;
END $$;

-- 4) Изчиства нулеви NULL-партида редове
DELETE FROM inventory WHERE batch_id IS NULL AND quantity = 0;

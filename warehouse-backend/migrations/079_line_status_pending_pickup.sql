-- 079_line_status_pending_pickup.sql
-- ----------------------------------------------------------------------
-- Добавя нова стойност 'pending_pickup' към line_status enum-подобния
-- CHECK constraint на order_items.
--
-- Контекст: когато клиент дойде да си вземе вече платена-невзета линия,
-- касиерът трябва да я "изпрати към склада за пакетиране" — складът
-- физически опакова и потвърждава предаването. Без междинно състояние
-- ние flip-вахме paid_not_taken → normal директно от UI на касата (Batch
-- F1), което не оставяше следа за склада.
--
-- Жизнен цикъл:
--   paid_not_taken         (платено при оригиналния fulfill, не взето)
--     ↓ POST /orders/:id/items/:itemId/send-to-warehouse  (касиер)
--   pending_pickup         (на склад за пакетиране)
--     ↓ POST /orders/:id/items/:itemId/handover           (склад)
--   normal                 (предадено на клиента)
--
-- Stock не се променя при тези преходи — namal-ен е вече при оригиналния
-- fulfill (с allowNegative=true за paid_not_taken линии).
-- ----------------------------------------------------------------------

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_line_status_check;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_line_status_check
  CHECK (line_status IN ('normal', 'paid_not_taken', 'awaiting', 'pending_pickup'));

COMMENT ON COLUMN order_items.line_status IS
  'normal = за пакетиране/изпълнена; paid_not_taken = платена, не взета;
   awaiting = pre-order чака стока; pending_pickup = клиентът дойде, на
   склад за финално пакетиране.';

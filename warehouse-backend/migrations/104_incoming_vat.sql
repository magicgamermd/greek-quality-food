-- ДДС по входящата доставка.
--
-- Досега доставката нямаше никакво понятие за ДДС: стоковата разписка
-- показваше само Междинна / Отстъпка / Общо. Когато фактурата на
-- доставчика е с ДДС, сумите не се връзваха.
--
-- Две отделни неща, затова две колони:
--
--   vat_rate            — ставката (20.00, 9.00, 0.00 при ВОП…).
--                         NULL = доставката е без ДДС, както досега.
--
--   prices_include_vat  — КЪДЕ седи ДДС-то:
--                         FALSE → цените по редовете са БЕЗ ДДС и
--                                 разписката добавя ДДС ред отдолу;
--                         TRUE  → ДДС-то вече е ВГРАДЕНО в единичните
--                                 цени (бутонът ги е умножил веднъж),
--                                 разписката го показва само справочно
--                                 „в т.ч. ДДС", без да добавя втори път.
--
-- Флагът е и предпазителят срещу двойно прилагане: щом е TRUE, повторно
-- „добави към цените" се отказва вместо да умножи по 1.44.
ALTER TABLE incoming_goods
  ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS prices_include_vat BOOLEAN NOT NULL DEFAULT FALSE;

-- Ставката е процент, не коефициент — пази от 0.20 вместо 20.
ALTER TABLE incoming_goods
  DROP CONSTRAINT IF EXISTS chk_incoming_vat_rate_range;
ALTER TABLE incoming_goods
  ADD CONSTRAINT chk_incoming_vat_rate_range
  CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100));

-- „Цените са с ДДС" без ставка е безсмислено състояние — не бива да се
-- получи при никакъв път през кода.
ALTER TABLE incoming_goods
  DROP CONSTRAINT IF EXISTS chk_incoming_vat_included_needs_rate;
ALTER TABLE incoming_goods
  ADD CONSTRAINT chk_incoming_vat_included_needs_rate
  CHECK (prices_include_vat = FALSE OR vat_rate IS NOT NULL);

COMMENT ON COLUMN incoming_goods.vat_rate IS
  'ДДС ставка в проценти за тази доставка; NULL = без ДДС';
COMMENT ON COLUMN incoming_goods.prices_include_vat IS
  'TRUE = ДДС-то е вградено в unit_price по редовете (не се добавя пак)';

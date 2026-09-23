-- По кое правило се печата единичната цена на фактура / проформа / КИ.
--
-- До 23.09.2026 фактурите печатаха цената като стойност ÷ количество
-- (6.317 × 2.8 = 17.69 → „6,318“). Поправката печата въведената цена, но
-- вече ИЗДАДЕНИТЕ документи не бива да се променят (чл. 116 ЗДДС) — а
-- сървърът няма постоянен диск за PDF-ите и след всеки деплой ги чертае
-- наново от данните. Затова всяка фактура носи правилото, по което е
-- издадена, и копие/английски/изгубен файл излиза точно както оригинала.
--
--   legacy_total_div_qty — издадена преди поправката (всички съществуващи)
--   entered              — въведената цена (всички нови; кодът я задава)
--
-- Подразбирането е СТАРОТО правило: така и документ, създаден от стария
-- код между миграцията и деплоя, остава както е издаден.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS unit_price_rule TEXT NOT NULL
    DEFAULT 'legacy_total_div_qty';

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS chk_invoices_unit_price_rule;
ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_unit_price_rule
  CHECK (unit_price_rule IN ('legacy_total_div_qty', 'entered'));

COMMENT ON COLUMN invoices.unit_price_rule IS
  'Как се печата единичната цена: legacy_total_div_qty (издадени до 23.09.2026) или entered';

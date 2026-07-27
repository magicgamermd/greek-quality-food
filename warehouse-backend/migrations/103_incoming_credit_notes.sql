-- 103: Входящи кредитни известия (КИ от доставчик).
--
-- Доставчик сгреши цената по фактура и издава кредитно известие. Досега
-- нямаше как да се заведе като ДОКУМЕНТ — оставаше само корекция на
-- цената в доставката, без следа кой документ я е породил.
--
-- Моделът е полиморфен върху incoming_goods (както invoices пази и
-- фактури, и кредитни известия на продажбената страна):
--   document_type = 'credit_note'  (колоната вече съществува, свободен текст)
--   invoice_number / invoice_date  = номерът и датата на КИ от доставчика
--   related_incoming_id            = оригиналната доставка
--   total_amount                   = ОТРИЦАТЕЛНА сума
--
-- Така дължимото към доставчика (сума по incoming_goods) и дневните
-- покупки се намаляват автоматично, без нова логика в отчетите.
--
-- ОРИГИНАЛНАТА доставка НЕ се пипа — тя остава каквато доставчикът я е
-- издал. Корекцията живее в КИ-то, а складовата стойност (партида +
-- покупна цена на продукта) се обновява отделно.

ALTER TABLE incoming_goods
  ADD COLUMN IF NOT EXISTS related_incoming_id INTEGER
    REFERENCES incoming_goods(id) ON DELETE SET NULL;

ALTER TABLE incoming_goods
  ADD COLUMN IF NOT EXISTS credit_note_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_incoming_goods_related_incoming
  ON incoming_goods(related_incoming_id)
  WHERE related_incoming_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_incoming_goods_document_type
  ON incoming_goods(document_type);

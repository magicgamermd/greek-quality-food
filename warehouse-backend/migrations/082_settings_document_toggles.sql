-- 082_settings_document_toggles.sql
-- Greek Quality Food: master switches за document UI елементи. При FALSE
-- се скриват автоматично в Orders документен ред и в drawer-а:
--   - warranty_enabled         → "Гаранция" бутон + warranty_number поле
--   - acceptance_protocol_enabled → "Приемо-предавателен" бутон + диалог
--   - replacement_enabled      → "Замяна" toggle в new order dialog
--                                и "Замени" филтър pill в листа на поръчки
--   - commercial_doc_enabled   → "Търговски документ" бутон (стокова
--                                разписка с партиди + срокове + цени)
--
-- Default TRUE (backward-compatible) — съществуващи инсталации продължават
-- да виждат всички документи; admin изключва каквото не му трябва.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS warranty_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS acceptance_protocol_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS replacement_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS commercial_doc_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN settings.warranty_enabled IS
  'UI master switch за "Гаранция" бутон в Orders drawer. FALSE = скрий.';

COMMENT ON COLUMN settings.acceptance_protocol_enabled IS
  'UI master switch за "Приемо-предавателен" бутон. FALSE = скрий.';

COMMENT ON COLUMN settings.replacement_enabled IS
  'UI master switch за "Замяна" toggle в new order + "Замени" филтър pill.';

COMMENT ON COLUMN settings.commercial_doc_enabled IS
  'UI master switch за "Търговски документ" бутон (стокова разписка с
   партиди + срокове на годност + цени).';

-- 081_settings_integrations.sql
-- Greek Quality Food: master switch за outbound интеграции (Econt
-- засега, бъдеще: Speedy, OPostBank, и т.н.).
--
-- MERT-M ползваше Econt активно за всички поръчки. За GQF искаме UI
-- toggle в Settings, който при OFF скрива Econt секциите/picker-ите
-- навсякъде (Orders new dialog, packing/dispatch screens, отчети).
-- Конфигурацията (ECONT_USERNAME/PASSWORD/SENDER_*) остава в .env —
-- не я триеме, просто я игнорираме на UI ниво.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS econt_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN settings.econt_enabled IS
  'Master switch за Econt интеграцията в UI. FALSE = скрий навсякъде.';

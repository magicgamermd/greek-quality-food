-- Стандартен A4 принтер за документи (фактури, стокови разписки, оферти)
-- от асистанта — отделен от Zebra принтера за етикети. POST /print/document
-- ползва `lp -d <това_име>`; ако е празно → системния default принтер.
-- Адитивна, backward-compatible миграция.
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS document_printer_name TEXT;

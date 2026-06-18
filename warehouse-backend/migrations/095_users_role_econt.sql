-- 091_users_role_econt.sql
-- Разширява users_role_check да допуска новата роля 'econt'.
-- Без това INSERT/UPDATE на потребител с role='econt' се отхвърля от
-- CHECK constraint-а (виж migration 053). Additive — само добавя стойност.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'warehouse', 'accountant', 'sales', 'econt'));

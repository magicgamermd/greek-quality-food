-- 099_users_role_owner_mobile.sql
-- Добавя роля 'owner_mobile' (вход за Owner PWA). Без нея owner потребител не може
-- да бъде създаден и само admin минава gate-а на /owner. Runner-ът обвива в транзакция.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'warehouse', 'accountant', 'sales', 'econt', 'owner_mobile'));

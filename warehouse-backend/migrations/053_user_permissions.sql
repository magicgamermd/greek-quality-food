-- 053_user_permissions.sql
-- Adds 'sales' role + per-user permission override table.
-- Purely additive: existing user roles are unchanged. Effective
-- permissions match prior behavior because role defaults computed
-- in code mirror today's scattered role checks.

BEGIN;

-- 1. Extend the role enum to include 'sales'
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'warehouse', 'accountant', 'sales'));

-- 2. New table for per-user permission overrides
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  granted     BOOLEAN NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user_id
  ON user_permission_overrides(user_id);

COMMIT;

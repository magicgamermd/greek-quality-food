-- Fix role CHECK constraint: rename 'readonly' → 'accountant'
-- The original migration (001) had CHECK (role IN ('admin', 'warehouse', 'readonly'))
-- but the application uses 'accountant' as the third role.

-- First update any existing 'readonly' rows to 'accountant'
UPDATE users SET role = 'accountant' WHERE role = 'readonly';

-- Drop old constraint and add corrected one
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'warehouse', 'accountant'));

-- Update default
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'accountant';

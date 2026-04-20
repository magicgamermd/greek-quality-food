#!/usr/bin/env bash
# Run all SQL migration files in order against DATABASE_URL.
# Usage: ./scripts/run-migrations.sh
# Requires: psql (PostgreSQL client)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${SCRIPT_DIR}/../migrations"

# Load .env if present
ENV_FILE="${SCRIPT_DIR}/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set. Export it or add to .env"
  exit 1
fi

if ! command -v psql &> /dev/null; then
  echo "ERROR: psql is not installed. Install PostgreSQL client first."
  exit 1
fi

echo "Running migrations against: ${DATABASE_URL%%@*}@***"

# Create tracking table if not exists
psql "$DATABASE_URL" -c "
  CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ DEFAULT NOW()
  );
" 2>/dev/null

# Support legacy schema where key column was `filename`
migration_key_column=$(psql "$DATABASE_URL" -tAc "
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = '_migrations'
        AND column_name = 'name'
    ) THEN 'name'
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = '_migrations'
        AND column_name = 'filename'
    ) THEN 'filename'
    ELSE ''
  END
" | xargs)

if [ -z "$migration_key_column" ]; then
  echo "ERROR: _migrations table exists but has no supported key column (name/filename)."
  exit 1
fi

# Run each migration file in order
for migration in "$MIGRATIONS_DIR"/*.sql; do
  filename="$(basename "$migration")"

  # Skip if already applied
  already_applied=$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM _migrations WHERE ${migration_key_column} = '$filename' LIMIT 1" 2>/dev/null | xargs)
  if [ "$already_applied" = "1" ]; then
    echo "SKIP: $filename (already applied)"
    continue
  fi

  echo "APPLYING: $filename ..."
  # Serialise across concurrent deploys using a session-level advisory
  # lock (same key every run). ON_ERROR_STOP + single-transaction means a
  # single failing statement rolls back the whole migration file.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction <<SQL
SELECT pg_advisory_lock(hashtext('greekfoods_migrations'));
\i $migration
INSERT INTO _migrations (${migration_key_column}) VALUES ('$filename');
SELECT pg_advisory_unlock(hashtext('greekfoods_migrations'));
SQL
  echo "OK: $filename"
done

echo "All migrations complete."

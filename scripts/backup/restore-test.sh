#!/usr/bin/env bash
# Weekly restore drill. Restores a backup into a scratch DB, runs sanity
# SELECTs, drops the scratch DB. Proves backups are actually restorable.
#
# Usage:
#   ./restore-test.sh /path/to/dump.gz
#   ./restore-test.sh latest         # pull newest from S3 (requires S3_BACKUP_BUCKET)
#
# Requires RESTORE_SUPERUSER_URL (or PG{HOST,PORT,USER,PASSWORD}) pointing at a
# Postgres instance where this script may CREATE/DROP databases. Do NOT use
# your production DATABASE_URL for this — use a staging server.

set -euo pipefail

log() {
  local level="$1"; shift
  echo "level=${level} ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ") $*"
}

fail() {
  log ERROR "msg=\"restore drill failed\" reason=\"$1\""
  # best-effort cleanup
  if [[ -n "${SCRATCH_DB:-}" ]]; then
    psql "${ADMIN_URL:-postgres://postgres@localhost/postgres}" \
      -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};" >/dev/null 2>&1 || true
  fi
  exit 1
}

TS_START=$(date +%s)
SOURCE="${1:-}"
[[ -z "$SOURCE" ]] && fail "usage: $0 <dump.gz|latest>"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# --- Acquire dump file ---------------------------------------------------------
DUMP_FILE=""
if [[ "$SOURCE" == "latest" ]]; then
  [[ -z "${S3_BACKUP_BUCKET:-}" ]] && fail "S3_BACKUP_BUCKET not set"
  command -v aws >/dev/null 2>&1 || fail "aws CLI not installed"
  LATEST_KEY=$(aws s3 ls "s3://${S3_BACKUP_BUCKET}/daily/" | sort | tail -1 | awk '{print $4}')
  [[ -z "$LATEST_KEY" ]] && fail "no daily backups in S3"
  DUMP_FILE="${WORK_DIR}/${LATEST_KEY}"
  aws s3 cp "s3://${S3_BACKUP_BUCKET}/daily/${LATEST_KEY}" "$DUMP_FILE" --only-show-errors \
    || fail "s3 download failed"
  log INFO "msg=\"downloaded\" file=${DUMP_FILE}"
else
  [[ ! -f "$SOURCE" ]] && fail "file not found: $SOURCE"
  DUMP_FILE="$SOURCE"
fi

# --- Decrypt if .gpg -----------------------------------------------------------
if [[ "$DUMP_FILE" == *.gpg ]]; then
  DECRYPTED="${WORK_DIR}/$(basename "${DUMP_FILE%.gpg}")"
  gpg --batch --yes --output "$DECRYPTED" --decrypt "$DUMP_FILE" \
    || fail "gpg decrypt failed"
  DUMP_FILE="$DECRYPTED"
  log INFO "msg=\"decrypted\" file=${DUMP_FILE}"
fi

# --- Gunzip to .dump -----------------------------------------------------------
if [[ "$DUMP_FILE" == *.gz ]]; then
  UNZIPPED="${WORK_DIR}/$(basename "${DUMP_FILE%.gz}")"
  gunzip -c "$DUMP_FILE" > "$UNZIPPED" || fail "gunzip failed"
  DUMP_FILE="$UNZIPPED"
fi

# --- Prepare scratch DB --------------------------------------------------------
ADMIN_URL="${RESTORE_SUPERUSER_URL:-postgres://postgres@localhost/postgres}"
SCRATCH_DB="greekfoods_restore_test_$(date +%s)"
log INFO "msg=\"creating scratch db\" name=${SCRATCH_DB}"

psql "$ADMIN_URL" -c "CREATE DATABASE ${SCRATCH_DB};" >/dev/null \
  || fail "CREATE DATABASE failed"

# Build URL for scratch DB (swap db name in ADMIN_URL)
SCRATCH_URL=$(echo "$ADMIN_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/${SCRATCH_DB}\1#")

# --- Restore -------------------------------------------------------------------
log INFO "msg=\"restoring\" source=${DUMP_FILE} target=${SCRATCH_DB}"
if ! pg_restore --no-owner --no-acl -d "$SCRATCH_URL" "$DUMP_FILE" 2> "${WORK_DIR}/restore.err"; then
  # pg_restore returns non-zero for warnings too; inspect stderr for hard errors
  if grep -Ei '^(pg_restore: error:|ERROR: )' "${WORK_DIR}/restore.err" >/dev/null; then
    cat "${WORK_DIR}/restore.err" >&2
    fail "pg_restore reported errors"
  fi
fi

# --- Sanity SELECTs ------------------------------------------------------------
check_table() {
  local table="$1"
  local min="$2"
  local count
  count=$(psql "$SCRATCH_URL" -tAc "SELECT COUNT(*) FROM ${table};" 2>/dev/null || echo ERR)
  if [[ "$count" == "ERR" ]]; then
    fail "SELECT from ${table} failed"
  fi
  log INFO "msg=\"sanity\" table=${table} rows=${count}"
  if [[ "$count" -lt "$min" ]]; then
    fail "${table} has ${count} rows (< minimum ${min})"
  fi
}

check_table "products"        1
check_table "suppliers"       1
check_table "incoming_goods"  0
check_table "invoices"        0
check_table "orders"          0

# --- Cleanup -------------------------------------------------------------------
psql "$ADMIN_URL" -c "DROP DATABASE ${SCRATCH_DB};" >/dev/null || true

DURATION=$(( $(date +%s) - TS_START ))
log INFO "msg=\"restore drill PASSED\" duration_s=${DURATION}"

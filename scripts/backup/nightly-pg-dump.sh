#!/usr/bin/env bash
# Nightly PostgreSQL backup for greek-foods-platform.
#
# - Reads DATABASE_URL (preferred) or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
# - Runs pg_dump -Fc (custom format), pipes through gzip.
# - Optionally GPG-encrypts (if BACKUP_GPG_RECIPIENT is set).
# - Uploads to S3 if S3_BACKUP_BUCKET is set; otherwise keeps local copy.
# - Retention: daily 7, weekly 4, monthly 3.
# - Emits structured log lines: JSON-ish key=value pairs to stdout.
# - Exits non-zero on failure.
#
# Usage:
#   DATABASE_URL=postgres://... ./nightly-pg-dump.sh
#   DATABASE_URL=... S3_BACKUP_BUCKET=greekfoods-backups ./nightly-pg-dump.sh
#   ./nightly-pg-dump.sh --dry-run

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

TS_START_EPOCH=$(date +%s)
TS_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
STAMP=$(date -u +"%Y%m%d-%H%M%S")

log() {
  # Structured log: level=<lvl> ts=<iso> msg="..." key=value ...
  local level="$1"; shift
  echo "level=${level} ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ") $*"
}

fail() {
  log ERROR "msg=\"backup failed\" reason=\"$1\""
  exit 1
}

# --- Resolve connection info ---------------------------------------------------
if [[ -z "${DATABASE_URL:-}" && -z "${PGDATABASE:-}" ]]; then
  fail "neither DATABASE_URL nor PGDATABASE set"
fi

DB_NAME="${PGDATABASE:-}"
if [[ -n "${DATABASE_URL:-}" ]]; then
  # extract db name for filename (strip query, keep last path segment)
  DB_NAME=$(echo "$DATABASE_URL" | sed -E 's#.*/([^/?]+).*#\1#')
fi
DB_NAME="${DB_NAME:-greekfoods}"

# --- Paths / naming ------------------------------------------------------------
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/postgres}"
FILENAME="greekfoods-warehouse-${STAMP}.dump.gz"
LOCAL_PATH="${LOCAL_DIR}/${FILENAME}"

log INFO "msg=\"backup starting\" db=${DB_NAME} target=${LOCAL_PATH} dry_run=${DRY_RUN}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log INFO "msg=\"dry run: would create directory\" path=${LOCAL_DIR}"
  log INFO "msg=\"dry run: would run\" cmd=\"pg_dump -Fc <conn> | gzip -9 > ${LOCAL_PATH}\""
  if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
    log INFO "msg=\"dry run: would gpg-encrypt\" recipient=${BACKUP_GPG_RECIPIENT} output=${LOCAL_PATH}.gpg"
  fi
  if [[ -n "${S3_BACKUP_BUCKET:-}" ]]; then
    log INFO "msg=\"dry run: would upload\" s3=s3://${S3_BACKUP_BUCKET}/daily/${FILENAME}"
  fi
  log INFO "msg=\"dry run: would apply retention\" daily=7 weekly=4 monthly=3"
  log INFO "msg=\"dry run complete\" duration_s=$(( $(date +%s) - TS_START_EPOCH ))"
  exit 0
fi

mkdir -p "$LOCAL_DIR"

# --- Run pg_dump ---------------------------------------------------------------
if [[ -n "${DATABASE_URL:-}" ]]; then
  if ! pg_dump -Fc --no-owner --no-acl "$DATABASE_URL" | gzip -9 > "$LOCAL_PATH"; then
    fail "pg_dump failed"
  fi
else
  if ! PGPASSWORD="${PGPASSWORD:-}" pg_dump -Fc --no-owner --no-acl \
        -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" \
        -U "${PGUSER:-postgres}" -d "${PGDATABASE}" | gzip -9 > "$LOCAL_PATH"; then
    fail "pg_dump failed"
  fi
fi

SIZE_BYTES=$(wc -c < "$LOCAL_PATH" | tr -d ' ')
if [[ "$SIZE_BYTES" -lt 1024 ]]; then
  fail "dump suspiciously small (${SIZE_BYTES} bytes)"
fi

log INFO "msg=\"dump complete\" file=${LOCAL_PATH} size_bytes=${SIZE_BYTES}"

# --- Optional GPG encryption ---------------------------------------------------
UPLOAD_PATH="$LOCAL_PATH"
if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  if ! command -v gpg >/dev/null 2>&1; then
    fail "BACKUP_GPG_RECIPIENT set but gpg not installed"
  fi
  ENC_PATH="${LOCAL_PATH}.gpg"
  if ! gpg --batch --yes --trust-model always \
        --recipient "$BACKUP_GPG_RECIPIENT" \
        --output "$ENC_PATH" --encrypt "$LOCAL_PATH"; then
    fail "gpg encryption failed"
  fi
  rm -f "$LOCAL_PATH"
  UPLOAD_PATH="$ENC_PATH"
  log INFO "msg=\"encrypted\" file=${UPLOAD_PATH} recipient=${BACKUP_GPG_RECIPIENT}"
fi

# --- Determine retention tier --------------------------------------------------
DOW=$(date -u +%u)    # 1..7 (Mon..Sun)
DOM=$(date -u +%d)    # 01..31
TIER="daily"
if [[ "$DOM" == "01" ]]; then
  TIER="monthly"
elif [[ "$DOW" == "7" ]]; then
  TIER="weekly"
fi
log INFO "msg=\"retention tier selected\" tier=${TIER}"

# --- Upload to S3 (optional) ---------------------------------------------------
if [[ -n "${S3_BACKUP_BUCKET:-}" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    fail "S3_BACKUP_BUCKET set but aws CLI not installed"
  fi
  S3_KEY="s3://${S3_BACKUP_BUCKET}/${TIER}/$(basename "$UPLOAD_PATH")"
  if ! aws s3 cp "$UPLOAD_PATH" "$S3_KEY" --only-show-errors; then
    fail "aws s3 cp failed"
  fi
  log INFO "msg=\"uploaded\" s3=${S3_KEY}"
fi

# --- Local retention -----------------------------------------------------------
# Keep last N by mtime. If S3 lifecycle policy handles retention remotely,
# local retention still runs (safe: only local dir).
prune() {
  local pattern="$1"
  local keep="$2"
  # sort by mtime desc, keep first N, delete rest
  # shellcheck disable=SC2012
  ls -1t "$LOCAL_DIR"/$pattern 2>/dev/null | tail -n +$((keep+1)) | while read -r old; do
    rm -f "$old"
    log INFO "msg=\"pruned\" file=${old}"
  done
}

# daily: keep 7 of everything created in the last week
find "$LOCAL_DIR" -maxdepth 1 -type f -name 'greekfoods-warehouse-*.dump.gz*' -mtime +7 -print0 2>/dev/null |
  while IFS= read -r -d '' old; do
    # never prune weekly-on-sunday or monthly-on-1st files younger than 4w / 3mo
    mtime_epoch=$(stat -f %m "$old" 2>/dev/null || stat -c %Y "$old")
    age_days=$(( (TS_START_EPOCH - mtime_epoch) / 86400 ))
    dom=$(date -u -r "$mtime_epoch" +%d 2>/dev/null || date -u -d "@$mtime_epoch" +%d)
    dow=$(date -u -r "$mtime_epoch" +%u 2>/dev/null || date -u -d "@$mtime_epoch" +%u)
    if [[ "$dom" == "01" && "$age_days" -lt 90 ]]; then continue; fi
    if [[ "$dow" == "7"  && "$age_days" -lt 28 ]]; then continue; fi
    rm -f "$old"
    log INFO "msg=\"pruned\" file=${old} age_days=${age_days}"
  done

# --- Done ----------------------------------------------------------------------
DURATION=$(( $(date +%s) - TS_START_EPOCH ))
log INFO "msg=\"backup complete\" db=${DB_NAME} size_bytes=${SIZE_BYTES} duration_s=${DURATION} tier=${TIER}"

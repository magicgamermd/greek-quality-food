#!/usr/bin/env bash
# ============================================================================
# generate-prod-secrets.sh
#
# Generates strong, cryptographically-random values for the core shared
# secrets used across warehouse-backend and ai-service.
#
# Output is .env-compatible and printed to stdout. Redirect to a file ONLY
# if you immediately upload to the secret store and then delete the file.
# Preferred workflow: copy-paste directly into Railway / 1Password / Keychain.
#
# Usage:
#   ./scripts/generate-prod-secrets.sh
#   ./scripts/generate-prod-secrets.sh | pbcopy          # macOS clipboard
#
# DO NOT commit the output. Files like prod-secrets.env are gitignored.
# ============================================================================

set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl is required but was not found in PATH" >&2
  exit 1
fi

JWT_SECRET="$(openssl rand -hex 64)"
INTERNAL_API_KEY="$(openssl rand -hex 32)"
POSTGRES_PASSWORD="$(openssl rand -base64 32 | tr -d '\n')"
REDIS_PASSWORD="$(openssl rand -base64 32 | tr -d '\n')"

cat <<EOF
# ----------------------------------------------------------------------------
# Greek Foods production secrets - generated $(date -u +"%Y-%m-%dT%H:%M:%SZ")
#
# DO NOT commit. Paste into Railway (or your host's secret store / 1Password).
# After pasting, delete any local copy. These values are cryptographically
# random and CANNOT be recovered - regenerate if lost.
#
# Targets:
#   - JWT_SECRET        -> warehouse-backend
#   - INTERNAL_API_KEY  -> warehouse-backend AND ai-service (as BACKEND_API_KEY)
#   - POSTGRES_PASSWORD -> warehouse-backend + DATABASE_URL
#   - REDIS_PASSWORD    -> warehouse-backend + ai-service + REDIS_URL
# ----------------------------------------------------------------------------

JWT_SECRET=${JWT_SECRET}
INTERNAL_API_KEY=${INTERNAL_API_KEY}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}

# For ai-service, also set:
# BACKEND_API_KEY=${INTERNAL_API_KEY}

# Remember to update DATABASE_URL and REDIS_URL so the passwords embedded
# in the connection strings match the values above.
EOF

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="${ROOT_DIR}/e2e-tests"

echo "🧪 МЕРТ-М E2E QA Suite"
echo "==========================="

if [ ! -d "$E2E_DIR" ]; then
  echo "❌ e2e-tests directory not found at: $E2E_DIR"
  exit 1
fi

cd "$E2E_DIR"
npx playwright test --reporter=list "$@"

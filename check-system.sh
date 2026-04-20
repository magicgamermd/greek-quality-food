#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
FAILURES=0

run_step() {
  local title="$1"
  shift
  echo
  echo "=== ${title} ==="
  if "$@"; then
    echo "✅ ${title}"
  else
    echo "❌ ${title}"
    FAILURES=$((FAILURES + 1))
  fi
}

run_step "Backend build" bash -lc "cd '${ROOT_DIR}/warehouse-backend' && npm run build"
run_step "Backend tests" bash -lc "cd '${ROOT_DIR}/warehouse-backend' && npm test"
run_step "Backend lint" bash -lc "cd '${ROOT_DIR}/warehouse-backend' && npm run lint"

run_step "Frontend build" bash -lc "cd '${ROOT_DIR}/warehouse-frontend' && npm run build"

run_step "AI service tests" bash -lc "cd '${ROOT_DIR}/ai-service' && AI_PYTEST='' && if [ -x './.venv311/bin/pytest' ]; then AI_PYTEST='./.venv311/bin/pytest'; elif [ -x './venv/bin/pytest' ]; then AI_PYTEST='./venv/bin/pytest'; elif [ -x './.venv312/bin/python' ]; then AI_PYTEST='./.venv312/bin/python -m pytest'; fi && if [ -z \"\$AI_PYTEST\" ]; then echo 'No working AI service test env found'; exit 1; fi && eval \"\$AI_PYTEST -q\""

run_step "Mobile app typecheck" bash -lc "cd '${ROOT_DIR}/mobile-app' && npx tsc --noEmit"
run_step "Mobile owner typecheck" bash -lc "cd '${ROOT_DIR}/mobile-owner-app' && npm run typecheck"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "🎯 System check passed (0 failures)."
  exit 0
fi

echo "⚠️  System check finished with ${FAILURES} failing step(s)."
exit 1

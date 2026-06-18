#!/usr/bin/env bash
# ============================================================================
# Greek Quality Food dev — single-command boot
#
# Starts the full local dev stack: Postgres + Redis Docker containers,
# warehouse-backend (tsx watch), warehouse-frontend (vite), ai-service
# (uvicorn). Idempotent — kills any stale processes from previous runs
# before starting new ones.
#
# Usage:    ./scripts/start-greekquality.sh           # start everything
#           ./scripts/start-greekquality.sh --status  # status only, no start
#           ./scripts/start-greekquality.sh --stop    # stop everything
#
# Logs go to /tmp/gqf-{backend,frontend,ai}.log
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="/tmp"

# ANSI colours (NO_COLOR-aware)
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  GREEN="\033[1;32m"; RED="\033[1;31m"; YELLOW="\033[1;33m"; BLUE="\033[1;34m"; RESET="\033[0m"
else
  GREEN=""; RED=""; YELLOW=""; BLUE=""; RESET=""
fi

ok()    { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "${YELLOW}⚠${RESET} %s\n" "$1"; }
err()   { printf "${RED}✗${RESET} %s\n" "$1"; }
info()  { printf "${BLUE}→${RESET} %s\n" "$1"; }

probe_http() {
  local url="$1" label="$2"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then ok "$label  →  HTTP 200"; return 0
  else err "$label  →  HTTP $code"; return 1
  fi
}

stop_dev_processes() {
  info "Stopping any existing Greek Quality Food dev processes..."
  # Case-insensitive (-i) защото path-овете на client-а са uppercase
  # /Applications/Greek Quality Food/..., а development checkout-а е lowercase
  # /Users/magic/Projects/greek-quality-food/... — без -i pkill пропускаше едната
  # вариант, оставяше stale tsx → EADDRINUSE crash при следващ старт.
  pkill -if "greek.quality.food/warehouse-backend.*tsx" 2>/dev/null || true
  pkill -if "greek.quality.food/warehouse-backend.*nodemon" 2>/dev/null || true
  pkill -if "greek.quality.food/warehouse-frontend.*vite" 2>/dev/null || true
  pkill -if "greek.quality.food/ai-service.*uvicorn" 2>/dev/null || true
  # Port-based kill като safety net — ако path-pattern-ите пропускат
  # някой процес заради exotic command-line, listening port-ът все
  # пак идентифицира runaway-а.
  for port in 3005 5175 8000; do
    if pid=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null); then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
}

ensure_docker() {
  info "Ensuring Greek Quality Food Postgres + Redis Docker containers are running..."
  if ! docker info >/dev/null 2>&1; then
    err "Docker daemon is not running. Start Docker Desktop and retry."
    exit 1
  fi

  for c in greekquality-postgres-1 greekquality-redis-1; do
    state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "missing")
    case "$state" in
      running)  ok "$c (already running)" ;;
      exited|created|paused)
                docker start "$c" >/dev/null && ok "$c (started)" ;;
      missing)  err "$c container does not exist. Run docker compose up first."
                exit 1 ;;
      *)        warn "$c in state '$state'" ;;
    esac
  done
}

start_backend() {
  info "Starting warehouse-backend on :3005..."
  cd "$ROOT/warehouse-backend"
  nohup npm run dev > "$LOG_DIR/gqf-backend.log" 2>&1 &
}

start_frontend() {
  info "Starting warehouse-frontend on :5175..."
  cd "$ROOT/warehouse-frontend"
  nohup npm run dev > "$LOG_DIR/gqf-frontend.log" 2>&1 &
}

start_ai() {
  info "Starting ai-service on :8000..."
  cd "$ROOT/ai-service"
  if [[ ! -x .venv311/bin/uvicorn ]]; then
    err "ai-service/.venv311/bin/uvicorn not found. Set up the venv first:"
    err "  cd ai-service && python3.11 -m venv .venv311 && ./.venv311/bin/pip install -e ."
    return 1
  fi
  if [[ ! -f .env ]]; then
    err "ai-service/.env missing. Copy .env.example and fill in values."
    return 1
  fi
  nohup bash -c 'set -a && source .env && set +a && \
    ./.venv311/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000' \
    > "$LOG_DIR/gqf-ai.log" 2>&1 &
}

wait_for_health() {
  info "Waiting for services to become healthy..."
  local deadline=$(( $(date +%s) + 30 ))
  while (( $(date +%s) < deadline )); do
    local b f a
    b=$(curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://localhost:3005/health 2>/dev/null || echo 000)
    f=$(curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://localhost:5175 2>/dev/null || echo 000)
    a=$(curl -s -o /dev/null -w "%{http_code}" --max-time 1 http://localhost:8000/health 2>/dev/null || echo 000)
    if [[ "$b" == "200" && "$f" == "200" && "$a" == "200" ]]; then return 0; fi
    sleep 1
  done
  return 1
}

print_status() {
  echo ""
  echo "==============================================="
  echo "  Greek Quality Food dev stack"
  echo "==============================================="
  probe_http "http://localhost:3005/health"  "backend  :3005"  || true
  probe_http "http://localhost:5175"         "frontend :5175"  || true
  probe_http "http://localhost:8000/health"  "ai-svc   :8000"  || true
  echo ""
  echo "Logs: $LOG_DIR/gqf-{backend,frontend,ai}.log"
  echo "Frontend: http://localhost:5175"
  echo "Admin login: see e2e-tests/.env.local (gitignored)"
}

case "${1:-start}" in
  --status|status)
    print_status
    ;;
  --stop|stop)
    stop_dev_processes
    ok "All Greek Quality Food dev processes stopped (Docker containers left running)."
    ;;
  start|--start|"")
    stop_dev_processes
    ensure_docker
    start_backend
    start_frontend
    start_ai || warn "ai-service did not start (check log)"
    if wait_for_health; then
      ok "All services healthy"
    else
      warn "Some services did not respond within 30s — check logs"
    fi
    print_status
    ;;
  --daemon|daemon)
    # Launchd режим: стартираме всичко, после БЛОКИРАМЕ безкрайно.
    # Без блокирането, scripts exit-ва с 0 → launchd с KeepAlive=true
    # го рестартира всеки 10 сек → cycle: kill running services →
    # start новi → exit → launchd kill again. С блокиране launchd
    # вижда скрипта като "живо", и единствено рестартира при реален
    # crash. Tail-ваме backend log-а за визуална обратна връзка в
    # launchd-stdout.
    stop_dev_processes
    ensure_docker
    start_backend
    start_frontend
    start_ai || warn "ai-service did not start (check log)"
    wait_for_health || warn "Initial health check did not pass — но launchd ще опита отново ако умре."
    print_status
    info "Daemon mode — blocking. Press Ctrl+C to stop."
    # Изчакваме backend tsx процеса. Когато умре, exec-ът завършва →
    # launchd го рестартира (със стопа отново на цикъла).
    backend_pid=$(lsof -tiTCP:3005 -sTCP:LISTEN 2>/dev/null | head -1)
    if [[ -n "$backend_pid" ]]; then
      # Poll-ваме съществуването на процеса. Без -lt fork-бомба guard.
      while kill -0 "$backend_pid" 2>/dev/null; do sleep 5; done
      warn "Backend process $backend_pid died — exit-ва script-а."
      exit 1
    else
      # Backend не стартира изобщо — exit с non-zero, launchd ще опита пак.
      err "Backend never started — exit-вам."
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 [start|--daemon|--status|--stop]"
    exit 2
    ;;
esac

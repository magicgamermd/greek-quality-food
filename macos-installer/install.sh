#!/usr/bin/env bash
# ============================================================
# Greek Quality Food Installer (macOS)
#
# Run on a fresh Mac at the client site. Installs all
# dependencies, clones the project to /Applications/Greek Quality Food,
# generates secrets, seeds the database with the product
# catalog + partner registry, and places the launcher .app
# bundles on the Desktop.
#
# Usage (from a USB stick or after `git clone`):
#   bash install.sh
# ============================================================
set -euo pipefail

PROJECT_DIR="/Applications/Greek Quality Food"
INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$HOME/gqf-data"
BACKUP_DIR="$DATA_DIR/backups"
GIT_REPO="${GQF_GIT_REPO:-}"

# ANSI colours
GREEN="\033[1;32m"; RED="\033[1;31m"; YELLOW="\033[1;33m"; BLUE="\033[1;34m"; RESET="\033[0m"
ok()   { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${RESET} %s\n" "$1"; }
err()  { printf "${RED}✗${RESET} %s\n" "$1"; }
info() { printf "${BLUE}→${RESET} %s\n" "$1"; }
step() { printf "\n${BLUE}━━━ %s ━━━${RESET}\n" "$1"; }

# ------------------------------------------------------------
step "1. Проверка на системата"
# ------------------------------------------------------------
if [[ "$(uname)" != "Darwin" ]]; then
  err "Този скрипт работи само на macOS"
  exit 1
fi
ok "macOS $(sw_vers -productVersion)"

# ------------------------------------------------------------
step "2. Homebrew"
# ------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  info "Инсталирам Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Ensure brew is on PATH for this session (Apple Silicon installs to /opt/homebrew)
  if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
  if [[ -x /usr/local/bin/brew ]];     then eval "$(/usr/local/bin/brew shellenv)"; fi
fi
ok "Homebrew $(brew --version | head -1)"

# ------------------------------------------------------------
step "3. Зависимости (git, node, python)"
# ------------------------------------------------------------
brew list git           >/dev/null 2>&1 || brew install git
brew list node@22       >/dev/null 2>&1 || brew install node@22
brew list python@3.11   >/dev/null 2>&1 || brew install python@3.11
# Ensure node@22 is on PATH (keg-only)
if ! command -v node >/dev/null 2>&1; then
  brew link --overwrite --force node@22
fi
ok "git $(git --version | awk '{print $3}')"
ok "node $(node --version)"
ok "python $(python3 --version | awk '{print $2}')"

# ------------------------------------------------------------
step "4. Docker (OrbStack препоръчан)"
# ------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  warn "Docker CLI не е намерен."
  echo "Препоръка: инсталирай OrbStack (https://orbstack.dev) ИЛИ Docker Desktop."
  echo "Натисни Enter след като инсталираш и стартираш Docker..."
  read -r
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker все още не е намерен."
    exit 1
  fi
fi
if ! docker info >/dev/null 2>&1; then
  err "Docker daemon не е стартиран. Стартирай OrbStack/Docker Desktop и пусни скрипта пак."
  exit 1
fi
ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

# ------------------------------------------------------------
step "5. Tailscale (за remote support)"
# ------------------------------------------------------------
if ! command -v tailscale >/dev/null 2>&1 && ! [[ -d "/Applications/Tailscale.app" ]]; then
  info "Инсталирам Tailscale..."
  brew install --cask tailscale
fi
ok "Tailscale е готов (стартирай го от Applications и логни се)"

# ------------------------------------------------------------
step "6. Project files"
# ------------------------------------------------------------
if [[ -d "$PROJECT_DIR/.git" ]]; then
  ok "$PROJECT_DIR вече съществува (skip git clone)"
else
  if [[ -n "$GIT_REPO" ]]; then
    info "Клонирам $GIT_REPO -> $PROJECT_DIR"
    sudo git clone "$GIT_REPO" "$PROJECT_DIR"
    sudo chown -R "$(whoami)" "$PROJECT_DIR"
  else
    # Copy from installer dir's parent (assumes installer ran from inside the project)
    PARENT="$(cd "$INSTALLER_DIR/.." && pwd)"
    if [[ -f "$PARENT/CLAUDE.md" && -d "$PARENT/warehouse-backend" ]]; then
      info "Копирам проекта от $PARENT -> $PROJECT_DIR"
      sudo mkdir -p "$PROJECT_DIR"
      sudo rsync -a --exclude='node_modules' --exclude='.venv*' --exclude='dist' --exclude='/tmp' "$PARENT/" "$PROJECT_DIR/"
      sudo chown -R "$(whoami)" "$PROJECT_DIR"
    else
      err "Не може да намери проекта. Задай GQF_GIT_REPO или стартирай install.sh от вътрешността на проекта."
      exit 1
    fi
  fi
fi

# ------------------------------------------------------------
step "7. .env (генерирани секрети)"
# ------------------------------------------------------------
if [[ ! -f "$PROJECT_DIR/warehouse-backend/.env" ]]; then
  info "Генерирам секрети..."
  PG_PW="$(openssl rand -hex 16)"
  RD_PW="$(openssl rand -hex 16)"
  JWT="$(openssl rand -hex 64)"
  IAK="$(openssl rand -hex 32)"
  ADMIN_PW="$(openssl rand -hex 8)"  # short, human-typeable

  cat > "$PROJECT_DIR/warehouse-backend/.env" <<EOF
NODE_ENV=production
PORT=3005
HOST=0.0.0.0

# Database (Postgres in greekquality-postgres-1 container, host port 5434)
POSTGRES_USER=greekquality
POSTGRES_PASSWORD=$PG_PW
POSTGRES_DB=greekquality_warehouse
DATABASE_URL=postgres://greekquality:$PG_PW@localhost:5434/greekquality_warehouse

# Redis (greekquality-redis-1, host port 6381)
REDIS_PASSWORD=$RD_PW
REDIS_URL=redis://:$RD_PW@localhost:6381

# JWT + internal API key
JWT_SECRET=$JWT
INTERNAL_API_KEY=$IAK

# AI service (uvicorn on host)
AI_SERVICE_URL=http://localhost:8000

# First-time admin (change after first login!)
ADMIN_EMAIL=admin@greek-quality-food.bg
ADMIN_PASSWORD=$ADMIN_PW
EOF
  chmod 600 "$PROJECT_DIR/warehouse-backend/.env"
  ok "Създаден $PROJECT_DIR/warehouse-backend/.env"
  echo ""
  warn "ВАЖНО: запиши admin паролата → $ADMIN_PW"
  warn "Ще ти потрябва за първо влизане. Сменете я след това!"
  echo ""
else
  ok ".env вече съществува (skip)"
fi

# ------------------------------------------------------------
step "8. Node + Python зависимости"
# ------------------------------------------------------------
info "warehouse-backend npm install..."
( cd "$PROJECT_DIR/warehouse-backend" && npm install --silent )
info "warehouse-frontend npm install..."
( cd "$PROJECT_DIR/warehouse-frontend" && npm install --silent )
ok "npm зависимости инсталирани"

# ------------------------------------------------------------
step "9. Стартиране на Postgres + Redis (Docker)"
# ------------------------------------------------------------
( cd "$PROJECT_DIR/warehouse-backend" && docker compose up -d postgres redis )
info "Изчаквам Postgres..."
for i in {1..30}; do
  if docker exec greekquality-postgres-1 pg_isready -U greekquality >/dev/null 2>&1; then
    ok "Postgres е готов"
    break
  fi
  sleep 1
done

# ------------------------------------------------------------
step "10. Migrations + import"
# ------------------------------------------------------------
( cd "$PROJECT_DIR/warehouse-backend" && npm run migrate )
ok "Migrations изпълнени"

# Import product catalog if available
if [[ -f "$PROJECT_DIR/data-imports/produkti-import.sql" ]]; then
  info "Импортвам каталога с продукти..."
  docker cp "$PROJECT_DIR/data-imports/produkti-import.sql" greekquality-postgres-1:/tmp/produkti.sql
  docker exec greekquality-postgres-1 psql -U greekquality -d greekquality_warehouse -f /tmp/produkti.sql >/dev/null
  docker exec greekquality-postgres-1 rm -f /tmp/produkti.sql
  ok "Продукти импортнати"
fi

if [[ -f "$PROJECT_DIR/data-imports/partneri-import.sql" ]]; then
  info "Импортвам партньорите..."
  docker cp "$PROJECT_DIR/data-imports/partneri-import.sql" greekquality-postgres-1:/tmp/partneri.sql
  docker exec greekquality-postgres-1 psql -U greekquality -d greekquality_warehouse -f /tmp/partneri.sql >/dev/null
  docker exec greekquality-postgres-1 rm -f /tmp/partneri.sql
  ok "Партньори импортнати"
fi

# ------------------------------------------------------------
step "11. Backup directory + LaunchAgent (daily pg_dump)"
# ------------------------------------------------------------
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
PLIST="$HOME/Library/LaunchAgents/bg.gqf.backup.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>          <string>bg.gqf.backup</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-c</string>
      <string>docker exec greekquality-postgres-1 pg_dump -U greekquality greekquality_warehouse | gzip > "$BACKUP_DIR/gqf-\$(date +%Y%m%d-%H%M%S).sql.gz"; ls -t "$BACKUP_DIR"/*.sql.gz | tail -n +31 | xargs -r rm</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>   <integer>3</integer>
      <key>Minute</key> <integer>0</integer>
    </dict>
    <key>StandardOutPath</key> <string>/tmp/gqf-backup.log</string>
    <key>StandardErrorPath</key> <string>/tmp/gqf-backup.log</string>
</dict>
</plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
ok "Daily backup в 03:00 -> $BACKUP_DIR (последни 30 пази)"

# ------------------------------------------------------------
step "12. Десктоп иконки"
# ------------------------------------------------------------
DESKTOP="$HOME/Desktop"
for app in "Start MERT-M.app" "Stop MERT-M.app" "Update MERT-M.app"; do
  if [[ -d "$INSTALLER_DIR/$app" ]]; then
    cp -R "$INSTALLER_DIR/$app" "$DESKTOP/"
    # Re-sign so Gatekeeper does not block
    codesign --force --deep --sign - "$DESKTOP/$app" 2>/dev/null || true
    ok "$DESKTOP/$app"
  fi
done

# ------------------------------------------------------------
echo ""
ok "Инсталацията е завършена!"
echo ""
echo "Следващи стъпки:"
echo "  1. Двойно щракни 'Start MERT-M' на десктопа за да стартираш."
echo "  2. Стартирай Tailscale.app и се логни (споделете акаунта с разработчика)."
echo "  3. Първо влизане: admin@greek-quality-food.bg / (паролата е в .env)"
echo ""
echo "Логове:"
echo "  /tmp/gqf-backend.log"
echo "  /tmp/gqf-frontend.log"
echo "  /tmp/gqf-ai.log"
echo "  /tmp/gqf-backup.log"
echo ""
echo "Backup-и: $BACKUP_DIR"
